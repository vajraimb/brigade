import type {
  Effect,
  InFlight,
  Msg,
  Pid,
  ProcFn,
  Process,
  Snapshot,
  TraceEvent,
  TraceOp,
} from "./types";

export type RuntimeOpts = {
  deliveryMs?: number;
};

export class Runtime {
  now = 0;
  nextPid = 1;
  nextMsgId = 1;
  nextSeq = 1;
  nextRef = 1;
  processes = new Map<Pid, Process>();
  names = new Map<string, Pid>();
  runQueue: Pid[] = [];
  inFlight: InFlight[] = [];
  events: TraceEvent[] = [];
  deliveryMs: number;
  reductions = 0;
  lastLoc: string | null = null;
  restartOf = new Map<string, number>();

  constructor(opts: RuntimeOpts = {}) {
    this.deliveryMs = opts.deliveryMs ?? 320;
  }

  spawn(
    name: string,
    fn: ProcFn,
    parent?: Pid,
    link = false,
  ): Pid {
    const pid = this.nextPid++;
    const restarts = this.restartOf.get(name) ?? 0;
    const proc: Process = {
      pid,
      name,
      gen: fn(),
      mailbox: [],
      alive: true,
      trapExit: false,
      links: new Set(),
      monitors: new Map(),
      watchedBy: new Map(),
      status: "runnable",
      parent,
      reductions: 0,
      startedAt: this.now,
      loc: null,
      lastOp: "spawn",
      wakeAt: null,
      sleepFrom: null,
      sleepMs: null,
      pred: null,
      resumeValue: undefined,
      booted: false,
      diedAt: null,
      reason: null,
      restartCount: restarts,
    };
    this.processes.set(pid, proc);
    if (parent != null && link) this.linkPair(parent, pid);
    this.runQueue.push(pid);
    this.trace("spawn", proc, `spawn ${name} #${pid}`, { loc: "actor.ml:spawn" });
    return pid;
  }

  whereis(name: string): Pid | undefined {
    return this.names.get(name);
  }

  inject(pid: Pid, msg: Msg) {
    const proc = this.processes.get(pid);
    if (!proc?.alive) return;
    this.arrive(proc, msg);
  }

  kill(pid: Pid, reason = "killed") {
    const proc = this.processes.get(pid);
    if (!proc?.alive) return;
    this.exit(proc, reason);
  }

  step(dtMs: number) {
    this.now += Math.max(0, dtMs);
    this.gcDead();
    this.deliverDue();
    this.wakeSleepers();
    this.drain(48);
  }

  flush(budget = 2000) {
    let guard = budget;
    while (guard-- > 0) {
      this.deliverDue();
      if (this.runQueue.length === 0) break;
      this.drain(64);
    }
  }

  snapshot(): Snapshot {
    const names: Record<string, Pid> = {};
    for (const [k, v] of this.names) names[k] = v;
    return {
      now: this.now,
      processes: [...this.processes.values()].map((p) => ({
        pid: p.pid,
        name: p.name,
        status: p.status,
        mailbox: p.mailbox.slice(),
        loc: p.loc,
        lastOp: p.lastOp,
        parent: p.parent,
        links: [...p.links],
        alive: p.alive,
        reductions: p.reductions,
        restartCount: p.restartCount,
        reason: p.reason,
        diedAt: p.diedAt,
        wakeAt: p.wakeAt,
        sleepFrom: p.sleepFrom,
        sleepMs: p.sleepMs,
        startedAt: p.startedAt,
      })),
      inFlight: this.inFlight.map((f) => {
        const span = Math.max(1, f.eta - f.sentAt);
        return {
          id: f.id,
          from: f.from,
          to: f.to,
          msg: f.msg,
          progress: Math.min(1, Math.max(0, (this.now - f.sentAt) / span)),
        };
      }),
      events: this.events.slice(0, 80),
      names,
      reductions: this.reductions,
      lastLoc: this.lastLoc,
    };
  }

  private drain(budget: number) {
    let n = budget;
    while (n-- > 0 && this.runQueue.length) {
      const pid = this.runQueue.shift()!;
      const proc = this.processes.get(pid);
      if (!proc?.alive || proc.status !== "runnable") continue;
      this.reduce(proc);
    }
  }

  private reduce(proc: Process) {
    try {
      const yielded = proc.booted
        ? proc.gen.next(proc.resumeValue)
        : proc.gen.next();
      proc.booted = true;
      proc.resumeValue = undefined;
      if (yielded.done) {
        this.exit(proc, "normal");
        return;
      }
      this.handle(proc, yielded.value);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.exit(proc, reason);
    }
  }

  private handle(proc: Process, effect: Effect) {
    proc.loc = effect.loc;
    proc.lastOp = effect.op;
    this.lastLoc = effect.loc;
    proc.reductions += 1;
    this.reductions += 1;

    switch (effect.op) {
      case "spawn": {
        const child = this.spawn(
          effect.name,
          effect.fn,
          proc.pid,
          effect.link ?? false,
        );
        proc.resumeValue = child;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        break;
      }
      case "send": {
        const dest =
          typeof effect.to === "string"
            ? this.names.get(effect.to)
            : effect.to;
        const msg = this.tagMsg(effect.msg);
        const stampedId = "id" in msg && typeof msg.id === "number" && msg.id > 0
          ? msg.id
          : this.nextMsgId++;
        const stamped = { ...msg, id: stampedId } as Msg;
        if (dest == null || !this.processes.get(dest)?.alive) {
          this.trace("drop", proc, `drop → ${String(effect.to)}`, {
            loc: effect.loc,
          });
        } else {
          this.inFlight.push({
            id: stampedId,
            from: proc.pid,
            to: dest,
            msg: stamped,
            sentAt: this.now,
            eta: this.now + this.deliveryMs,
          });
          this.trace(
            "send",
            proc,
            `send ${labelOf(stamped)} → #${dest}`,
            {
              loc: effect.loc,
              to: dest,
              msgId: stampedId,
            },
          );
        }
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        break;
      }
      case "receive": {
        const found = this.scan(proc, effect.pred);
        if (found) {
          this.trace(
            "receive",
            proc,
            `receive ${labelOf(found)}`,
            { loc: effect.loc, msgId: "id" in found ? found.id : undefined },
          );
          proc.resumeValue = found;
          proc.status = "runnable";
          proc.pred = null;
          proc.wakeAt = null;
          this.runQueue.push(proc.pid);
        } else {
          proc.status = "receiving";
          proc.pred = effect.pred;
          proc.wakeAt =
            effect.timeout != null ? this.now + effect.timeout : null;
          proc.sleepFrom = this.now;
          proc.sleepMs = effect.timeout ?? null;
        }
        break;
      }
      case "self":
        proc.resumeValue = proc.pid;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        break;
      case "sleep":
        proc.status = "sleeping";
        proc.sleepFrom = this.now;
        proc.sleepMs = effect.ms;
        proc.wakeAt = this.now + effect.ms;
        this.trace("sleep", proc, `sleep ${effect.ms | 0}ms`, {
          loc: effect.loc,
        });
        break;
      case "register":
        this.names.set(effect.name, proc.pid);
        proc.resumeValue = undefined;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        this.trace("register", proc, `register ${effect.name}`, {
          loc: effect.loc,
        });
        break;
      case "whereis":
        proc.resumeValue = this.names.get(effect.name) ?? null;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        break;
      case "link":
        this.linkPair(proc.pid, effect.pid);
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        this.trace("link", proc, `link #${effect.pid}`, { loc: effect.loc });
        break;
      case "unlink":
        this.unlinkPair(proc.pid, effect.pid);
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        this.trace("unlink", proc, `unlink #${effect.pid}`, { loc: effect.loc });
        break;
      case "trap_exit":
        proc.trapExit = effect.on;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        break;
      case "now":
        proc.resumeValue = this.now;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        break;
      case "exit":
        this.exit(proc, effect.reason);
        break;
      case "exit_pid": {
        const dest = this.processes.get(effect.pid);
        if (dest?.alive) this.signalExit(proc, dest, effect.reason);
        proc.status = "runnable";
        if (proc.alive) this.runQueue.push(proc.pid);
        break;
      }
      case "monitor": {
        const ref = this.nextRef++;
        proc.resumeValue = ref;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        this.installMonitor(proc, effect.pid, ref);
        this.trace("monitor", proc, `monitor #${effect.pid} ref ${ref}`, {
          loc: effect.loc,
          to: effect.pid,
        });
        break;
      }
      case "demonitor": {
        this.dropMonitor(proc, effect.ref, effect.flush === true);
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
        this.trace("demonitor", proc, `demonitor ref ${effect.ref}`, {
          loc: effect.loc,
        });
        break;
      }
    }
  }

  private tagMsg(msg: Msg): Msg {
    if ("id" in msg && typeof msg.id === "number" && msg.id > 0) return msg;
    if (msg.t === "Crash" || msg.t === "Timeout" || msg.t === "EXIT" || msg.t === "DOWN") return msg;
    const id = this.nextMsgId++;
    return { ...msg, id } as Msg;
  }

  private scan(proc: Process, pred: (m: Msg) => boolean): Msg | undefined {
    const q = proc.mailbox;
    for (let i = 0; i < q.length; i++) {
      const m = q[i];
      if (m && pred(m)) {
        q.splice(i, 1);
        return m;
      }
    }
    return undefined;
  }

  private deliverDue() {
    if (this.inFlight.length === 0) return;
    const due: InFlight[] = [];
    const keep: InFlight[] = [];
    for (const f of this.inFlight) {
      if (f.eta <= this.now) due.push(f);
      else keep.push(f);
    }
    this.inFlight = keep;
    for (const f of due) {
      const dest = this.processes.get(f.to);
      if (!dest?.alive) continue;
      this.arrive(dest, f.msg);
    }
  }

  private arrive(proc: Process, msg: Msg) {
    proc.mailbox.push(msg);
    if (proc.status === "receiving" && proc.pred) {
      const found = this.scan(proc, proc.pred);
      if (found) {
        this.trace(
          "receive",
          proc,
          `receive ${labelOf(found)}`,
          { loc: proc.loc ?? undefined, msgId: "id" in found ? found.id : undefined },
        );
        proc.pred = null;
        proc.wakeAt = null;
        proc.sleepFrom = null;
        proc.sleepMs = null;
        proc.resumeValue = found;
        proc.status = "runnable";
        proc.lastOp = "receive";
        this.runQueue.push(proc.pid);
      }
    }
  }

  private wakeSleepers() {
    for (const proc of this.processes.values()) {
      if (!proc.alive || proc.wakeAt == null || proc.wakeAt > this.now) continue;
      if (proc.status === "sleeping") {
        proc.status = "runnable";
        proc.wakeAt = null;
        proc.sleepFrom = null;
        proc.sleepMs = null;
        proc.resumeValue = undefined;
        this.runQueue.push(proc.pid);
      } else if (proc.status === "receiving") {
        proc.pred = null;
        proc.wakeAt = null;
        proc.sleepFrom = null;
        proc.sleepMs = null;
        proc.resumeValue = { t: "Timeout" } satisfies Msg;
        proc.status = "runnable";
        this.runQueue.push(proc.pid);
      }
    }
  }

  private installMonitor(watcher: Process, targetPid: Pid, ref: number) {
    const dest = this.processes.get(targetPid);
    if (!dest?.alive) {
      this.arrive(watcher, {
        t: "DOWN",
        ref,
        pid: targetPid,
        reason: "noproc",
      });
      return;
    }
    watcher.monitors.set(ref, targetPid);
    dest.watchedBy.set(ref, watcher.pid);
  }

  private dropMonitor(watcher: Process, ref: number, flush: boolean) {
    const targetPid = watcher.monitors.get(ref);
    watcher.monitors.delete(ref);
    if (targetPid != null) this.processes.get(targetPid)?.watchedBy.delete(ref);
    if (flush) {
      watcher.mailbox = watcher.mailbox.filter(
        (m) => !(m.t === "DOWN" && m.ref === ref),
      );
    }
  }

  private notifyMonitors(proc: Process, reason: string) {
    const watchers = [...proc.watchedBy];
    proc.watchedBy.clear();
    for (const [ref, watcherPid] of watchers) {
      const w = this.processes.get(watcherPid);
      if (!w?.alive) continue;
      w.monitors.delete(ref);
      this.arrive(w, { t: "DOWN", ref, pid: proc.pid, reason });
    }
    for (const [ref, targetPid] of proc.monitors) {
      this.processes.get(targetPid)?.watchedBy.delete(ref);
    }
    proc.monitors.clear();
  }

  private linkPair(a: Pid, b: Pid) {
    this.processes.get(a)?.links.add(b);
    this.processes.get(b)?.links.add(a);
  }

  private unlinkPair(a: Pid, b: Pid) {
    this.processes.get(a)?.links.delete(b);
    this.processes.get(b)?.links.delete(a);
  }

  /** Erlang exit/2: trap_exit converts the signal to a message; otherwise die.
   *  `normal` does not kill another process. `kill` always kills. */
  private signalExit(from: Process, dest: Process, reason: string) {
    if (reason === "kill") {
      this.exit(dest, "killed");
      return;
    }
    if (dest.trapExit) {
      this.arrive(dest, { t: "EXIT", pid: from.pid, reason });
      return;
    }
    if (reason === "normal" && dest.pid !== from.pid) return;
    this.exit(dest, reason);
  }

  private propagate(from: Process, reason: string) {
    const linked = [...from.links];
    from.links.clear();
    for (const otherPid of linked) {
      const other = this.processes.get(otherPid);
      if (!other?.alive) continue;
      other.links.delete(from.pid);
      if (other.trapExit) {
        this.arrive(other, { t: "EXIT", pid: from.pid, reason });
      } else if (reason !== "normal") {
        this.exit(other, reason);
      }
    }
  }

  private exit(proc: Process, reason: string) {
    if (!proc.alive) return;
    proc.alive = false;
    proc.status = "dead";
    proc.reason = reason;
    proc.diedAt = this.now;
    proc.mailbox = [];
    proc.pred = null;
    proc.wakeAt = null;
    const crashing = reason !== "normal";
    proc.lastOp = crashing ? "crash" : "exit";
    this.lastLoc = crashing ? "actor.ml:die" : "actor.ml:retc";
    if (this.names.get(proc.name) === proc.pid) this.names.delete(proc.name);
    for (const [name, pid] of [...this.names]) {
      if (pid === proc.pid) this.names.delete(name);
    }
    if (!proc.name.startsWith("order-")) {
      this.restartOf.set(proc.name, (this.restartOf.get(proc.name) ?? 0) + 1);
    }
    this.trace(crashing ? "crash" : "exit", proc, `${proc.name} ${reason}`, {
      loc: crashing ? "actor.ml:die" : "actor.ml:retc",
    });
    this.notifyMonitors(proc, reason);
    this.propagate(proc, reason);
  }

  private gcDead() {
    for (const [pid, proc] of this.processes) {
      if (!proc.alive && proc.diedAt != null && this.now - proc.diedAt > 900) {
        this.processes.delete(pid);
      }
    }
  }

  noteRestart(name: string) {
    const n = (this.restartOf.get(name) ?? 0) + 1;
    this.restartOf.set(name, n);
    return n;
  }

  private trace(
    op: TraceOp,
    proc: Process,
    detail: string,
    extra: Partial<TraceEvent> = {},
  ) {
    this.events.unshift({
      at: this.now,
      seq: this.nextSeq++,
      pid: proc.pid,
      name: proc.name,
      op,
      detail,
      ...extra,
    });
    if (this.events.length > 120) this.events.length = 120;
  }
}

export function labelOf(msg: Msg): string {
  switch (msg.t) {
    case "Ticket":
      return `Ticket ${msg.item}`;
    case "Plated":
      return `Plated ${msg.item}`;
    case "Ready":
      return `Ready ${msg.item}`;
    case "Crash":
      return "Crash";
    case "EXIT":
      return `EXIT #${msg.pid} ${msg.reason}`;
    case "StartChild":
      return `StartChild ${msg.item.name}`;
    case "Timeout":
      return "Timeout";
    case "Term":
      return msg.tag;
    case "DOWN":
      return `DOWN #${msg.pid} ${msg.reason}`;
    case "Call":
      return `Call ${String(msg.req)}`;
    case "Reply":
      return `Reply ${String(msg.reply)}`;
    case "Cast":
      return `Cast ${String(msg.req)}`;
  }
}
