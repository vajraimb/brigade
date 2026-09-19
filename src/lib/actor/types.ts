export type Pid = number;
export type Ref = number;

export type Station = "grill" | "fry" | "pass";

export type MenuItem = {
  id: string;
  name: string;
  station: Station;
  cookMs: number;
  poison: boolean;
};

/** Generic term for the OTP semantic suite. Kitchen messages stay separate. */
export type Term = { t: "Term"; tag: string; payload?: unknown };

export type Msg =
  | {
      t: "Ticket";
      id: number;
      station: Station;
      item: string;
      order: Pid;
      poison: boolean;
      cookMs: number;
    }
  | { t: "Plated"; id: number; item: string; order: Pid }
  | { t: "Ready"; id: number; item: string; order: Pid }
  | { t: "Crash" }
  | { t: "EXIT"; pid: Pid; reason: string }
  | { t: "DOWN"; ref: Ref; pid: Pid; reason: string }
  | { t: "Call"; from: Pid; ref: Ref; req: unknown }
  | { t: "Reply"; ref: Ref; reply: unknown }
  | { t: "Cast"; req: unknown }
  | { t: "StartChild"; item: MenuItem; key: string }
  | { t: "Timeout" }
  | Term;

export type ProcFn = () => Generator<Effect, void, unknown>;

export type Effect =
  | { op: "spawn"; name: string; fn: ProcFn; link?: boolean; loc: string }
  | { op: "send"; to: Pid | string; msg: Msg; loc: string }
  | { op: "receive"; pred: (m: Msg) => boolean; timeout?: number; loc: string }
  | { op: "self"; loc: string }
  | { op: "sleep"; ms: number; loc: string }
  | { op: "register"; name: string; loc: string }
  | { op: "whereis"; name: string; loc: string }
  | { op: "link"; pid: Pid; loc: string }
  | { op: "unlink"; pid: Pid; loc: string }
  | { op: "trap_exit"; on: boolean; loc: string }
  | { op: "now"; loc: string }
  | { op: "exit"; reason: string; loc: string }
  | { op: "exit_pid"; pid: Pid; reason: string; loc: string }
  | { op: "monitor"; pid: Pid; loc: string }
  | { op: "demonitor"; ref: Ref; flush?: boolean; loc: string };

export type ProcessStatus =
  | "runnable"
  | "receiving"
  | "sleeping"
  | "dead";

export type Process = {
  pid: Pid;
  name: string;
  gen: Generator<Effect, void, unknown>;
  mailbox: Msg[];
  alive: boolean;
  trapExit: boolean;
  links: Set<Pid>;
  /** ref → target this process monitors */
  monitors: Map<Ref, Pid>;
  /** ref → watcher monitoring this process */
  watchedBy: Map<Ref, Pid>;
  status: ProcessStatus;
  parent?: Pid;
  reductions: number;
  startedAt: number;
  loc: string | null;
  lastOp: Effect["op"] | "crash" | "exit" | null;
  wakeAt: number | null;
  sleepFrom: number | null;
  sleepMs: number | null;
  pred: ((m: Msg) => boolean) | null;
  resumeValue: unknown;
  booted: boolean;
  diedAt: number | null;
  reason: string | null;
  restartCount: number;
};

export type InFlight = {
  id: number;
  from: Pid;
  to: Pid;
  msg: Msg;
  sentAt: number;
  eta: number;
};

export type TraceOp =
  | "spawn"
  | "send"
  | "receive"
  | "sleep"
  | "crash"
  | "restart"
  | "exit"
  | "register"
  | "link"
  | "unlink"
  | "monitor"
  | "demonitor"
  | "drop";

export type TraceEvent = {
  at: number;
  seq: number;
  pid: Pid;
  name: string;
  op: TraceOp;
  detail: string;
  loc?: string;
  from?: Pid;
  to?: Pid;
  msgId?: number;
};

export type ProcSnap = {
  pid: Pid;
  name: string;
  status: ProcessStatus;
  mailbox: Msg[];
  loc: string | null;
  lastOp: Process["lastOp"];
  parent?: Pid;
  links: Pid[];
  alive: boolean;
  reductions: number;
  restartCount: number;
  reason: string | null;
  diedAt: number | null;
  wakeAt: number | null;
  sleepFrom: number | null;
  sleepMs: number | null;
  startedAt: number;
};

export type Snapshot = {
  now: number;
  processes: ProcSnap[];
  inFlight: {
    id: number;
    from: Pid;
    to: Pid;
    msg: Msg;
    progress: number;
  }[];
  events: TraceEvent[];
  names: Record<string, Pid>;
  reductions: number;
  lastLoc: string | null;
};

export function term(tag: string, payload?: unknown): Term {
  return payload === undefined ? { t: "Term", tag } : { t: "Term", tag, payload };
}

export function E() {
  return {
    spawn: (name: string, fn: ProcFn, loc: string, link = true): Effect => ({
      op: "spawn",
      name,
      fn,
      link,
      loc,
    }),
    send: (to: Pid | string, msg: Msg, loc: string): Effect => ({
      op: "send",
      to,
      msg,
      loc,
    }),
    receive: (
      pred: (m: Msg) => boolean,
      loc: string,
      timeout?: number,
    ): Effect => ({ op: "receive", pred, timeout, loc }),
    self: (loc: string): Effect => ({ op: "self", loc }),
    sleep: (ms: number, loc: string): Effect => ({ op: "sleep", ms, loc }),
    register: (name: string, loc: string): Effect => ({
      op: "register",
      name,
      loc,
    }),
    whereis: (name: string, loc: string): Effect => ({
      op: "whereis",
      name,
      loc,
    }),
    link: (pid: Pid, loc: string): Effect => ({ op: "link", pid, loc }),
    unlink: (pid: Pid, loc: string): Effect => ({ op: "unlink", pid, loc }),
    trap_exit: (on: boolean, loc: string): Effect => ({
      op: "trap_exit",
      on,
      loc,
    }),
    now: (loc: string): Effect => ({ op: "now", loc }),
    exit: (reason: string, loc: string): Effect => ({ op: "exit", reason, loc }),
    exit_pid: (pid: Pid, reason: string, loc: string): Effect => ({
      op: "exit_pid",
      pid,
      reason,
      loc,
    }),
    monitor: (pid: Pid, loc: string): Effect => ({ op: "monitor", pid, loc }),
    demonitor: (ref: Ref, loc: string, flush = false): Effect => ({
      op: "demonitor",
      ref,
      flush,
      loc,
    }),
  };
}

export const fx = E();
