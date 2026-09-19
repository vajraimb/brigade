import { fx, type MenuItem, type Msg, type Pid, type ProcFn } from "./types.ts";

export type Strategy = "one_for_one" | "one_for_all" | "rest_for_one";
export type Restart = "permanent" | "transient" | "temporary";

export type ChildSpec = {
  id: string;
  start: ProcFn;
  restart: Restart;
};

type ChildRow = { spec: ChildSpec; pid: Pid; hist: number[] };

export function supervise(opts: {
  name: string;
  specs: ChildSpec[];
  strategy?: Strategy;
  intensity?: number;
  period?: number;
}): ProcFn {
  const strategy = opts.strategy ?? "one_for_one";
  const intensity = opts.intensity ?? 6;
  const period = opts.period ?? 12000;
  return function* () {
    yield fx.register(opts.name, "supervisor.ml:register");
    yield fx.trap_exit(true, "supervisor.ml:trap_exit");
    const children: ChildRow[] = [];
    for (const spec of opts.specs) {
      const pid = (yield fx.spawn(
        spec.id,
        spec.start,
        "supervisor.ml:spawn",
        true,
      )) as Pid;
      children.push({ spec, pid, hist: [] });
    }
    const shutting = new Set<Pid>();
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "EXIT" || m.t === "Crash",
        "supervisor.ml:receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("supervisor abort");
      if (msg.t !== "EXIT") continue;
      if (shutting.has(msg.pid)) {
        shutting.delete(msg.pid);
        continue;
      }
      const idx = children.findIndex((c) => c.pid === msg.pid);
      if (idx < 0) continue;
      const row = children[idx]!;
      const skip =
        row.spec.restart === "temporary" ||
        (row.spec.restart === "transient" && msg.reason === "normal");
      if (skip) {
        children.splice(idx, 1);
        continue;
      }
      const t = (yield fx.now("supervisor.ml:intensity")) as number;
      row.hist = [t, ...row.hist.filter((h) => t - h <= period)];
      if (row.hist.length > intensity) throw new Error("intensity exceeded");

      let from = idx;
      let to = idx;
      if (strategy === "one_for_all") {
        from = 0;
        to = children.length - 1;
      } else if (strategy === "rest_for_one") {
        from = idx;
        to = children.length - 1;
      }

      for (let i = from; i <= to; i++) {
        if (i === idx) continue;
        const sib = children[i]!;
        shutting.add(sib.pid);
        yield fx.exit_pid(sib.pid, "shutdown", "supervisor.ml:shutdown");
      }

      for (let i = from; i <= to; i++) {
        const child = children[i]!;
        if (i !== idx && child.spec.restart === "temporary") continue;
        const pid = (yield fx.spawn(
          child.spec.id,
          child.spec.start,
          "supervisor.ml:restart",
          true,
        )) as Pid;
        child.pid = pid;
      }
    }
  };
}

export function simpleOneForOne(
  name: string,
  make: (item: MenuItem, seq: number) => { id: string; fn: ProcFn },
): ProcFn {
  return function* () {
    yield fx.register(name, "supervisor.ml:sofs.register");
    yield fx.trap_exit(true, "supervisor.ml:sofs.trap_exit");
    let n = 1;
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "StartChild" || m.t === "EXIT" || m.t === "Crash",
        "supervisor.ml:sofs.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("service abort");
      if (msg.t === "StartChild") {
        const child = make(msg.item, n++);
        yield fx.spawn(child.id, child.fn, "supervisor.ml:sofs.spawn", true);
      }
    }
  };
}
