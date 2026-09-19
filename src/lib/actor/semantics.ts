import { Runtime } from "./runtime.ts";
import { simpleOneForOne, supervise } from "./supervisor.ts";
import { call, echo, startLink } from "./gen_server.ts";
import {
  fx,
  term,
  type MenuItem,
  type Msg,
  type Pid,
  type ProcFn,
  type Ref,
} from "./types.ts";

const L = "semantics.ml:run";

export type SemGroup =
  | "combo"
  | "primitive"
  | "mailbox"
  | "link"
  | "supervisor"
  | "monitor"
  | "genserver";

export type SemResult = {
  ok: boolean;
  want: string;
  got: string;
  before?: string[];
  after?: string[];
  taken?: string;
  step?: string;
  diagram?: {
    left: { name: string; live: boolean; trap?: boolean };
    right: { name: string; live: boolean; trap?: boolean };
    signal: string;
  };
};

export type SemCase = {
  id: string;
  group: SemGroup;
  primitive: string;
  title: string;
  erlang: string;
  /** Hierarchical contract id, e.g. gen_server/call/timeout. */
  path?: string;
  run: () => SemResult;
};

export const GROUP_LABEL: Record<SemGroup, string> = {
  combo: "组合",
  monitor: "monitor",
  genserver: "gen_server",
  primitive: "原语",
  mailbox: "邮箱",
  link: "链接 / 退出",
  supervisor: "监督树",
};

/** Kernel cases that Erlang/OTP 29.1 should print identically. */
export const OTP_IDS = [
  "spawn",
  "send-receive",
  "fifo",
  "selective-receive",
  "mailbox-dies",
  "drop-dead",
  "link-cascade",
  "normal-no-cascade",
  "trap-exit",
  "system-message",
  "kill-untrappable",
  "unlink-isolates",
  "exit-pid",
  "monitor-down",
  "monitor-noproc",
  "demonitor-flush",
  "demonitor-leaves",
  "gs-call",
  "gs-call-crash",
  "gs-call-timeout",
  "gs-call-empty",
  "gs-cast",
] as const;

/** Same ids as OTP_IDS, named for UI / TSV / OCaml / Erlang. */
export const OTP_PATH: Record<(typeof OTP_IDS)[number], string> = {
  spawn: "process/spawn",
  "send-receive": "process/send-receive",
  fifo: "mailbox/fifo",
  "selective-receive": "mailbox/selective",
  "mailbox-dies": "mailbox/dies",
  "drop-dead": "mailbox/drop-dead",
  "link-cascade": "link/cascade",
  "normal-no-cascade": "link/normal",
  "trap-exit": "link/trap-exit",
  "system-message": "link/system-message",
  "kill-untrappable": "link/kill",
  "unlink-isolates": "link/unlink",
  "exit-pid": "link/exit-pid",
  "monitor-down": "monitor/down",
  "monitor-noproc": "monitor/noproc",
  "demonitor-flush": "monitor/demonitor-flush",
  "demonitor-leaves": "monitor/demonitor-leaves",
  "gs-call": "gen_server/call/ok",
  "gs-call-crash": "gen_server/call/crash",
  "gs-call-timeout": "gen_server/call/timeout",
  "gs-call-empty": "gen_server/call/empty",
  "gs-cast": "gen_server/cast",
};

const DUMMY: MenuItem = {
  id: "x",
  name: "x",
  station: "grill",
  cookMs: 1,
  poison: false,
};

function rt() {
  return new Runtime({ deliveryMs: 0 });
}

function show(x: unknown): string {
  if (Array.isArray(x)) return `[${x.join(", ")}]`;
  if (x === undefined) return "undefined";
  if (x === null) return "null";
  return String(x);
}

function eq(want: unknown, got: unknown, extra?: Partial<SemResult>): SemResult {
  const w = show(want);
  const g = show(got);
  return { ok: w === g, want: w, got: g, ...extra };
}

function tagsOf(r: Runtime, pid: Pid | undefined): string[] {
  if (pid == null) return [];
  const p = r.processes.get(pid);
  if (!p) return [];
  return p.mailbox.map((m) => {
    if (m.t === "Term") return m.tag;
    if (m.t === "EXIT") return `EXIT ${m.reason}`;
    if (m.t === "DOWN") return `DOWN ${m.reason}`;
    return m.t;
  });
}

function park(name: string): ProcFn {
  return function* () {
    yield fx.register(name, L);
    yield fx.receive((m) => m.t === "Crash", L);
    throw new Error("boom");
  };
}

function boom(name: string): ProcFn {
  return function* () {
    yield fx.register(name, L);
    throw new Error("boom");
  };
}

function halt(name: string): ProcFn {
  return function* () {
    yield fx.register(name, L);
  };
}

export const CASES: SemCase[] = [
  {
    id: "spawn",
    group: "primitive",
    primitive: "spawn",
    title: "spawn 返回新 Pid",
    erlang: "Pid = spawn(fun() -> ... end)  — 新进程，独立 mailbox",
    run() {
      const r = rt();
      const pid = r.spawn("box", park("box"), undefined, false);
      r.flush();
      const p = r.processes.get(pid);
      return eq(true, p?.alive === true && p.pid === pid && p.mailbox.length === 0);
    },
  },
  {
    id: "send-receive",
    group: "primitive",
    primitive: "send / receive",
    title: "send 异步投递，receive 取出",
    erlang: "Pid ! Msg,  receive Msg -> ok end",
    run() {
      const r = rt();
      let got = "";
      r.spawn(
        "ping",
        function* () {
          const pid = (yield fx.spawn(
            "pong",
            function* () {
              const m = (yield fx.receive((x) => x.t === "Term", L)) as Msg;
              if (m.t === "Term") got = m.tag;
            },
            L,
            false,
          )) as Pid;
          yield fx.send(pid, term("hi"), L);
        },
        undefined,
        false,
      );
      r.flush();
      return eq("hi", got);
    },
  },
  {
    id: "fifo",
    group: "mailbox",
    primitive: "mailbox ordering",
    title: "匹配消息按到达顺序 FIFO",
    erlang: "mailbox 是队列：先到的匹配消息先被 receive",
    run() {
      const r = rt();
      const got: string[] = [];
      r.spawn(
        "box",
        function* () {
          yield fx.register("box", L);
          yield fx.sleep(1, L);
          for (let i = 0; i < 3; i++) {
            const m = (yield fx.receive((x) => x.t === "Term", L)) as Msg;
            if (m.t === "Term") got.push(m.tag);
          }
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const pid = r.whereis("box")!;
      for (const tag of ["a", "b", "c"]) r.inject(pid, term(tag));
      r.step(2);
      r.flush();
      return eq(["a", "b", "c"], got);
    },
  },
  {
    id: "selective-receive",
    group: "mailbox",
    primitive: "selective receive",
    title: "selective receive 只取第一条匹配",
    erlang:
      "[fry, grill, pass, grill, fry]  receive grill  →  [fry, pass, grill, fry]",
    run() {
      const r = rt();
      let taken = "";
      r.spawn(
        "box",
        function* () {
          yield fx.register("box", L);
          yield fx.sleep(1, L);
          const m = (yield fx.receive(
            (x) => x.t === "Term" && x.tag === "grill",
            L,
          )) as Msg;
          if (m.t === "Term") taken = m.tag;
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const pid = r.whereis("box")!;
      for (const tag of ["fry", "grill", "pass", "grill", "fry"]) {
        r.inject(pid, term(tag));
      }
      const before = tagsOf(r, pid);
      r.step(2);
      r.flush();
      const after = tagsOf(r, pid);
      const wantAfter = ["fry", "pass", "grill", "fry"];
      return eq(wantAfter, after, { before, after, taken });
    },
  },
  {
    id: "mailbox-dies",
    group: "mailbox",
    primitive: "exit",
    title: "进程死，邮箱一起烧掉",
    erlang: "Pid 的 mailbox 是 process state。crash 后全部消失，不是 fiber 重启同一函数",
    run() {
      const r = rt();
      r.spawn("box", park("box"), undefined, false);
      r.flush();
      const pid = r.whereis("box")!;
      r.inject(pid, term("fry"));
      r.inject(pid, term("grill"));
      r.flush();
      const before = tagsOf(r, pid);
      r.kill(pid, "killed");
      r.flush();
      const p = r.processes.get(pid);
      return eq(
        ["dead", "[]"].join(" "),
        [`${p?.alive ? "alive" : "dead"}`, show(tagsOf(r, pid))].join(" "),
        { before, after: tagsOf(r, pid) },
      );
    },
  },
  {
    id: "drop-dead",
    group: "mailbox",
    primitive: "send",
    title: "发给已死 Pid 是静默丢弃",
    erlang: "send to a dead pid is a silent drop, like Erlang",
    run() {
      const r = rt();
      const dead = r.spawn(
        "ghost",
        function* () {
          yield fx.register("ghost", L);
        },
        undefined,
        false,
      );
      r.flush();
      r.spawn(
        "src",
        function* () {
          yield fx.send(dead, term("late"), L);
        },
        undefined,
        false,
      );
      r.flush();
      const drops = r.events.filter((e) => e.op === "drop").length;
      return eq(1, drops);
    },
  },
  {
    id: "whereis",
    group: "primitive",
    primitive: "whereis",
    title: "whereis 跟的是注册名，不是旧 Pid",
    erlang: "register / whereis。死后名字解开；重启后是 Pid 18，不是 17",
    run() {
      const r = rt();
      r.spawn("sup", supervise({
        name: "sup",
        specs: [{ id: "grill", start: park("grill"), restart: "permanent" }],
      }));
      r.flush();
      const first = r.whereis("grill");
      r.kill(first!, "killed");
      r.flush();
      const second = r.whereis("grill");
      const okPid = first != null && second != null && second !== first;
      return eq("new-pid", okPid ? "new-pid" : `first=${show(first)} second=${show(second)}`);
    },
  },
  {
    id: "stale-pid",
    group: "mailbox",
    primitive: "Pid",
    title: "旧 Pid 不会把信转给新厨师",
    erlang: "send Pid17 Msg 在 17 死后丢弃。whereis 才是 18。Pid ≠ worker function",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          specs: [{ id: "grill", start: park("grill"), restart: "permanent" }],
        }),
      );
      r.flush();
      const old = r.whereis("grill")!;
      r.kill(old, "killed");
      r.flush();
      const neu = r.whereis("grill")!;
      r.spawn(
        "src",
        function* () {
          yield fx.send(old, term("late"), L);
          yield fx.send(neu, term("fresh"), L);
        },
        undefined,
        false,
      );
      r.flush();
      const drops = r.events.filter((e) => e.op === "drop").length;
      const mail = tagsOf(r, neu);
      return eq(
        "drop 1 · [fresh]",
        `drop ${drops} · ${show(mail)}`,
        { before: ["late → #17"], after: mail, step: "drop" },
      );
    },
  },
  {
    id: "link-cascade",
    group: "link",
    primitive: "link",
    title: "未 trap 的 link 会级联退出",
    erlang: "link(Pid). 对方异常退出，自己也死",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.spawn("b", park("b"), L, true);
          yield fx.receive((m) => m.t === "Crash", L);
        },
        undefined,
        false,
      );
      r.flush();
      const a = [...r.processes.values()].find((p) => p.name === "a")!;
      r.kill(a.pid, "killed");
      r.flush();
      const alive = [...r.processes.values()].filter((p) => p.alive).length;
      return eq(0, alive, {
        diagram: {
          left: { name: "A", live: false },
          right: { name: "B", live: false },
          signal: "exit killed → cascade",
        },
      });
    },
  },
  {
    id: "normal-no-cascade",
    group: "link",
    primitive: "exit/1 normal",
    title: "normal 退出不杀死未 trap 的链接",
    erlang: "exit(normal) 通知链接，但不让对方死。{'EXIT', Pid, normal} 只在 trap 时进邮箱",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          yield fx.spawn("b", halt("b"), L, true);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const a = r.whereis("a");
      const b = [...r.processes.values()].find((p) => p.name === "b");
      return eq(
        "A alive, B normal",
        `${r.processes.get(a!)?.alive ? "A alive" : "A dead"}, B ${b?.reason ?? "gone"}`,
        {
          diagram: {
            left: { name: "A", live: r.processes.get(a!)?.alive === true },
            right: { name: "B", live: false },
            signal: "normal — no cascade",
          },
        },
      );
    },
  },
  {
    id: "trap-exit",
    group: "link",
    primitive: "trap_exit",
    title: "trap_exit 把信号变成 EXIT 消息",
    erlang: "process_flag(trap_exit, true) → {'EXIT', Pid, Reason}",
    run() {
      const r = rt();
      let reason = "";
      r.spawn(
        "sup",
        function* () {
          yield fx.register("sup", L);
          yield fx.trap_exit(true, L);
          yield fx.spawn("w", park("w"), L, true);
          const m = (yield fx.receive((x) => x.t === "EXIT", L)) as Msg;
          if (m.t === "EXIT") reason = m.reason;
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.kill(r.whereis("w")!, "killed");
      r.flush();
      const sup = r.processes.get(r.whereis("sup")!)!;
      return eq(["killed", true].join(" "), [reason, sup.alive].join(" "), {
        diagram: {
          left: { name: "A", live: true, trap: true },
          right: { name: "B", live: false },
          signal: "{'EXIT', B, killed}",
        },
      });
    },
  },
  {
    id: "system-message",
    group: "link",
    primitive: "system message",
    title: "EXIT 进同一只邮箱，receive 可以跳过它",
    erlang:
      "[grill, EXIT killed, fry]  receive fry  →  [grill, EXIT killed]  — 业务消息和退出信号走同一条 perform Receive",
    run() {
      const r = rt();
      let taken = "";
      r.spawn(
        "box",
        function* () {
          yield fx.register("box", L);
          yield fx.trap_exit(true, L);
          yield fx.spawn("w", park("w"), L, true);
          yield fx.sleep(1, L);
          const m = (yield fx.receive(
            (x) => x.t === "Term" && x.tag === "fry",
            L,
          )) as Msg;
          if (m.t === "Term") taken = m.tag;
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const box = r.whereis("box")!;
      r.inject(box, term("grill"));
      r.kill(r.whereis("w")!, "killed");
      r.flush();
      r.inject(box, term("fry"));
      const before = tagsOf(r, box);
      r.step(2);
      r.flush();
      const after = tagsOf(r, box);
      return eq(["grill", "EXIT killed"], after, {
        before,
        after,
        taken,
        diagram: {
          left: { name: "A", live: true, trap: true },
          right: { name: "B", live: false },
          signal: "EXIT → mailbox",
        },
      });
    },
  },
  {
    id: "kill-untrappable",
    group: "link",
    primitive: "exit/2 kill",
    title: "kill 不可 trap，目标一定死成 killed",
    erlang: "exit(Pid, kill) 无视 trap_exit。目标以 killed 退出；链接上的 killed 才可以 trap",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const b = (yield fx.spawn(
            "b",
            function* () {
              yield fx.register("b", L);
              yield fx.trap_exit(true, L);
              yield fx.sleep(99999, L);
            },
            L,
            false,
          )) as Pid;
          yield fx.exit_pid(b, "kill", L);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const a = r.whereis("a");
      const b = [...r.processes.values()].find((p) => p.name === "b");
      return eq(
        "A alive, B killed",
        `${r.processes.get(a!)?.alive ? "A alive" : "A dead"}, B ${b?.reason ?? "gone"}`,
        {
          diagram: {
            left: { name: "A", live: true },
            right: { name: "B", live: false, trap: true },
            signal: "kill (untrappable)",
          },
        },
      );
    },
  },
  {
    id: "unlink-isolates",
    group: "link",
    primitive: "unlink",
    title: "unlink 之后对方死不再传染",
    erlang: "unlink(Pid) 双向解开。之后 B 崩溃，A 还活着",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const b = (yield fx.spawn("b", park("b"), L, true)) as Pid;
          yield fx.unlink(b, L);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.kill(r.whereis("b")!, "killed");
      r.flush();
      const a = r.whereis("a");
      const b = [...r.processes.values()].find((p) => p.name === "b");
      return eq(
        "A alive, B dead",
        `${r.processes.get(a!)?.alive ? "A alive" : "A dead"}, B ${b?.alive ? "alive" : "dead"}`,
        {
          diagram: {
            left: { name: "A", live: true },
            right: { name: "B", live: false },
            signal: "unlinked",
          },
        },
      );
    },
  },
  {
    id: "exit-pid",
    group: "link",
    primitive: "exit/2",
    title: "exit(Pid, Reason) 杀掉未 trap 的目标",
    erlang: "exit(Pid, shutdown) 对未 trap 进程是致命信号；发送者自己还活着",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const b = (yield fx.spawn("b", park("b"), L, false)) as Pid;
          yield fx.exit_pid(b, "shutdown", L);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const a = r.whereis("a");
      const b = [...r.processes.values()].find((p) => p.name === "b");
      return eq(
        ["alive", "dead"].join(" "),
        [r.processes.get(a!)?.alive ? "alive" : "dead", b?.alive ? "alive" : "dead"].join(" "),
      );
    },
  },
  {
    id: "one-for-one",
    group: "supervisor",
    primitive: "one_for_one",
    title: "one_for_one 只重启死掉的那个",
    erlang: "只重启出错的 child；兄弟继续跑",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          strategy: "one_for_one",
          specs: [
            { id: "a", start: park("a"), restart: "permanent" },
            { id: "b", start: park("b"), restart: "permanent" },
            { id: "c", start: park("c"), restart: "permanent" },
          ],
        }),
      );
      r.flush();
      const a1 = r.whereis("a")!;
      const b1 = r.whereis("b")!;
      const c1 = r.whereis("c")!;
      r.kill(b1, "killed");
      r.flush();
      const a2 = r.whereis("a");
      const b2 = r.whereis("b");
      const c2 = r.whereis("c");
      return eq(
        "A same, B new, C same",
        a2 === a1 && b2 !== b1 && c2 === c1
          ? "A same, B new, C same"
          : `a ${a1}→${a2} b ${b1}→${b2} c ${c1}→${c2}`,
      );
    },
  },
  {
    id: "one-for-all",
    group: "supervisor",
    primitive: "one_for_all",
    title: "one_for_all 全员关掉再拉起来",
    erlang: "一个挂，其余先 shutdown，再按启动顺序全部 restart",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          strategy: "one_for_all",
          specs: [
            { id: "a", start: park("a"), restart: "permanent" },
            { id: "b", start: park("b"), restart: "permanent" },
            { id: "c", start: park("c"), restart: "permanent" },
          ],
        }),
      );
      r.flush();
      const a1 = r.whereis("a")!;
      const b1 = r.whereis("b")!;
      const c1 = r.whereis("c")!;
      r.kill(b1, "killed");
      r.flush();
      const a2 = r.whereis("a");
      const b2 = r.whereis("b");
      const c2 = r.whereis("c");
      return eq(
        "all new",
        a2 !== a1 && b2 !== b1 && c2 !== c1
          ? "all new"
          : `a ${a1}→${a2} b ${b1}→${b2} c ${c1}→${c2}`,
      );
    },
  },
  {
    id: "rest-for-one",
    group: "supervisor",
    primitive: "rest_for_one",
    title: "rest_for_one 杀掉它后面启动的",
    erlang: "B 挂：A 不动；B 与其后启动的 C 重启",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          strategy: "rest_for_one",
          specs: [
            { id: "a", start: park("a"), restart: "permanent" },
            { id: "b", start: park("b"), restart: "permanent" },
            { id: "c", start: park("c"), restart: "permanent" },
          ],
        }),
      );
      r.flush();
      const a1 = r.whereis("a")!;
      const b1 = r.whereis("b")!;
      const c1 = r.whereis("c")!;
      r.kill(b1, "killed");
      r.flush();
      const a2 = r.whereis("a");
      const b2 = r.whereis("b");
      const c2 = r.whereis("c");
      return eq(
        "A same, B new, C new",
        a2 === a1 && b2 !== b1 && c2 !== c1
          ? "A same, B new, C new"
          : `a ${a1}→${a2} b ${b1}→${b2} c ${c1}→${c2}`,
      );
    },
  },
  {
    id: "temporary",
    group: "supervisor",
    primitive: "temporary",
    title: "temporary child 死了不重启",
    erlang: "restart = temporary → 任何退出都不重启",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          specs: [{ id: "t", start: park("t"), restart: "temporary" }],
        }),
      );
      r.flush();
      const first = r.whereis("t");
      r.kill(first!, "killed");
      r.flush();
      return eq("gone", r.whereis("t") == null ? "gone" : "restarted");
    },
  },
  {
    id: "transient",
    group: "supervisor",
    primitive: "transient",
    title: "transient 正常退出不重启，异常才重启",
    erlang: "transient: normal → 忘掉；crash → restart",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          specs: [{ id: "t", start: halt("t"), restart: "transient" }],
        }),
      );
      r.flush();
      const afterNormal = r.whereis("t");
      const r2 = rt();
      r2.spawn(
        "sup",
        supervise({
          name: "sup",
          specs: [{ id: "t", start: boom("t"), restart: "transient" }],
        }),
      );
      r2.flush();
      const afterCrash = r2.whereis("t");
      const crashed = [...r2.processes.values()].filter((p) => p.name === "t");
      const restarted = crashed.length >= 2 || (afterCrash != null && crashed.length >= 1);
      return eq(
        "normal-gone crash-restarted",
        `${afterNormal == null ? "normal-gone" : "normal-kept"} ${restarted ? "crash-restarted" : "crash-gone"}`,
      );
    },
  },
  {
    id: "intensity",
    group: "supervisor",
    primitive: "restart intensity",
    title: "超过 intensity，supervisor 自己死",
    erlang: "maxR restarts in maxT → supervisor dies, 上一级接手",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          intensity: 2,
          period: 10_000,
          specs: [{ id: "w", start: boom("w"), restart: "permanent" }],
        }),
      );
      r.flush();
      const sup = [...r.processes.values()].find((p) => p.name === "sup");
      return eq("dead", sup?.alive ? "alive" : "dead");
    },
  },
  {
    id: "simple-one-for-one",
    group: "supervisor",
    primitive: "simple_one_for_one",
    title: "simple_one_for_one 的 child 是 temporary",
    erlang: "StartChild 克隆模板；child 死了忘掉，不重启",
    run() {
      const r = rt();
      r.spawn(
        "sofs",
        simpleOneForOne("sofs", (_item, n) => ({
          id: `job-${n}`,
          fn: park(`job-${n}`),
        })),
      );
      r.flush();
      const sofs = r.whereis("sofs")!;
      r.inject(sofs, { t: "StartChild", item: DUMMY, key: "x" });
      r.flush();
      const job = [...r.processes.values()].find((p) => p.name.startsWith("job-") && p.alive);
      if (!job) return eq("job", "missing");
      r.kill(job.pid, "killed");
      r.flush();
      const aliveJobs = [...r.processes.values()].filter(
        (p) => p.name.startsWith("job-") && p.alive,
      ).length;
      const sofsAlive = r.processes.get(sofs)?.alive === true;
      return eq("0 still-up", `${aliveJobs} ${sofsAlive ? "still-up" : "sofs-dead"}`);
    },
  },
  {
    id: "combo-retry",
    group: "combo",
    primitive: "link + receive + trap + restart",
    title: "重启时，receive 跳过 EXIT，旧 Pid 丢信",
    erlang:
      "observer trap+link 厨师。厨师挂 → supervisor spawn 新 Pid。mailbox [ticket, EXIT killed, ready] receive ready → [ticket, EXIT killed]。send #17 drops。",
    run() {
      const r = rt();
      let taken = "";
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          specs: [{ id: "grill", start: park("grill"), restart: "permanent" }],
        }),
      );
      r.flush();
      const old = r.whereis("grill")!;
      r.spawn(
        "obs",
        function* () {
          yield fx.register("obs", L);
          yield fx.trap_exit(true, L);
          const g = (yield fx.whereis("grill", L)) as Pid | null;
          if (g != null) yield fx.link(g, L);
          yield fx.sleep(1, L);
          const m = (yield fx.receive(
            (x) => x.t === "Term" && x.tag === "ready",
            L,
          )) as Msg;
          if (m.t === "Term") taken = m.tag;
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const obs = r.whereis("obs")!;
      r.inject(obs, term("ticket"));
      r.kill(old, "killed");
      r.flush();
      const neu = r.whereis("grill");
      r.inject(obs, term("ready"));
      const before = tagsOf(r, obs);
      r.step(2);
      r.flush();
      const after = tagsOf(r, obs);
      r.spawn(
        "src",
        function* () {
          yield fx.send(old, term("late"), L);
        },
        undefined,
        false,
      );
      r.flush();
      const drops = r.events.filter((e) => e.op === "drop").length;
      const okPid = neu != null && neu !== old;
      return eq(
        "ready · new pid · drop 1 · [ticket, EXIT killed]",
        `${taken} · ${okPid ? "new pid" : "same pid"} · drop ${drops} · ${show(after)}`,
        {
          before,
          after,
          taken,
          diagram: {
            left: { name: "obs", live: true, trap: true },
            right: { name: "grill", live: true },
            signal: `${old} → ${neu ?? "?"}`,
          },
        },
      );
    },
  },
  {
    id: "combo-rest-mail",
    group: "combo",
    primitive: "rest_for_one + mailbox",
    title: "rest_for_one 关掉后面的，它们的邮箱一起烧掉",
    erlang:
      "A,B,C 各有一封信。B 挂：A 还在且信还在；B、C 邮箱随进程消失；B' C' 空邮箱。",
    run() {
      const r = rt();
      r.spawn(
        "sup",
        supervise({
          name: "sup",
          strategy: "rest_for_one",
          specs: [
            { id: "a", start: park("a"), restart: "permanent" },
            { id: "b", start: park("b"), restart: "permanent" },
            { id: "c", start: park("c"), restart: "permanent" },
          ],
        }),
      );
      r.flush();
      const a1 = r.whereis("a")!;
      const b1 = r.whereis("b")!;
      const c1 = r.whereis("c")!;
      r.inject(a1, term("a1"));
      r.inject(b1, term("b1"));
      r.inject(c1, term("c1"));
      r.flush();
      r.kill(b1, "killed");
      r.flush();
      const a2 = r.whereis("a");
      const b2 = r.whereis("b");
      const c2 = r.whereis("c");
      const aMail = tagsOf(r, a2);
      const bOldMail = tagsOf(r, b1);
      const cOldMail = tagsOf(r, c1);
      const bNewMail = tagsOf(r, b2);
      const cNewMail = tagsOf(r, c2);
      const shape =
        a2 === a1 &&
        b2 !== b1 &&
        c2 !== c1 &&
        show(aMail) === "[a1]" &&
        show(bOldMail) === "[]" &&
        show(cOldMail) === "[]" &&
        show(bNewMail) === "[]" &&
        show(cNewMail) === "[]";
      return eq(
        "A keeps [a1]; B,C mail gone; B',C' empty",
        shape
          ? "A keeps [a1]; B,C mail gone; B',C' empty"
          : `a ${show(aMail)} bOld ${show(bOldMail)} cOld ${show(cOldMail)} b' ${show(bNewMail)} c' ${show(cNewMail)}`,
        {
          before: ["a1", "b1", "c1"],
          after: aMail,
          step: "B crash → rest_for_one",
        },
      );
    },
  },
  {
    id: "combo-intensity-parent",
    group: "combo",
    primitive: "intensity + parent",
    title: "下级 intensity 爆了，上一级把整棵子树拉起来",
    erlang:
      "line_sup maxR=2 被 boom 打穿。root trap 收到 EXIT，restart line_sup。新厨师是新 Pid。",
    run() {
      const r = rt();
      r.spawn(
        "root",
        supervise({
          name: "root",
          intensity: 10,
          specs: [
            {
              id: "line",
              start: supervise({
                name: "line",
                intensity: 2,
                period: 10_000,
                specs: [{ id: "w", start: park("w"), restart: "permanent" }],
              }),
              restart: "permanent",
            },
          ],
        }),
      );
      r.flush();
      for (let i = 0; i < 3; i++) {
        const w = r.whereis("w");
        if (w != null) r.kill(w, "killed");
        r.flush();
      }
      const root = r.whereis("root");
      const lines = [...r.processes.values()].filter((p) => p.name === "line");
      const workers = [...r.processes.values()].filter((p) => p.name === "w");
      const rootLive = root != null && r.processes.get(root)?.alive === true;
      const lineRestarted = lines.length >= 2;
      const workerRestarted = workers.length >= 2;
      return eq(
        "root alive · line restarted · w restarted",
        `${rootLive ? "root alive" : "root dead"} · ${lineRestarted ? "line restarted" : "line once"} · ${workerRestarted ? "w restarted" : "w once"}`,
        {
          diagram: {
            left: { name: "root", live: rootLive, trap: true },
            right: { name: "line", live: lines.some((p) => p.alive) },
            signal: "intensity → restart tree",
          },
        },
      );
    },
  },
  {
    id: "monitor-down",
    group: "monitor",
    primitive: "monitor",
    title: "monitor 是单向的，DOWN 进邮箱，监视者不死",
    erlang: "erlang:monitor(process, Pid). B 死 → {'DOWN', Ref, process, B, Reason}。A 还活着，没有 EXIT。",
    run() {
      const r = rt();
      let reason = "";
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const b = (yield fx.spawn("b", park("b"), L, false)) as Pid;
          const ref = (yield fx.monitor(b, L)) as Ref;
          const m = (yield fx.receive((x) => x.t === "DOWN" && x.ref === ref, L)) as Msg;
          if (m.t === "DOWN") reason = m.reason;
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.kill(r.whereis("b")!, "killed");
      r.flush();
      const a = r.whereis("a");
      return eq(
        "DOWN killed · A alive",
        `DOWN ${reason} · ${r.processes.get(a!)?.alive ? "A alive" : "A dead"}`,
        {
          diagram: {
            left: { name: "A", live: true },
            right: { name: "B", live: false },
            signal: "DOWN (no cascade)",
          },
        },
      );
    },
  },
  {
    id: "monitor-noproc",
    group: "monitor",
    primitive: "monitor noproc",
    title: "监视已死 Pid，立刻 DOWN noproc",
    erlang: "monitor 一个不存在的 Pid → 立即 {'DOWN', Ref, process, Pid, noproc}",
    run() {
      const r = rt();
      let reason = "";
      const ghost = r.spawn("ghost", halt("ghost"), undefined, false);
      r.flush();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const ref = (yield fx.monitor(ghost, L)) as Ref;
          const m = (yield fx.receive((x) => x.t === "DOWN" && x.ref === ref, L)) as Msg;
          if (m.t === "DOWN") reason = m.reason;
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      return eq("noproc", reason);
    },
  },
  {
    id: "demonitor-flush",
    group: "monitor",
    primitive: "demonitor flush",
    title: "demonitor flush 把已到的 DOWN 从邮箱拿走",
    erlang: "demonitor(Ref, [flush]) 解开监视并扫掉对应 DOWN",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const b = (yield fx.spawn("b", park("b"), L, false)) as Pid;
          const ref = (yield fx.monitor(b, L)) as Ref;
          yield fx.sleep(1, L);
          yield fx.demonitor(ref, L, true);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.kill(r.whereis("b")!, "killed");
      r.flush();
      const a = r.whereis("a")!;
      r.step(2);
      r.flush();
      return eq("[]", tagsOf(r, a), { after: tagsOf(r, a), step: "demonitor flush" });
    },
  },
  {
    id: "demonitor-leaves",
    group: "monitor",
    primitive: "demonitor",
    title: "demonitor 不 flush 则 DOWN 留在邮箱",
    erlang: "demonitor(Ref) 只解开。已经入队的 DOWN 还在，receive 可以取到。",
    run() {
      const r = rt();
      r.spawn(
        "a",
        function* () {
          yield fx.register("a", L);
          const b = (yield fx.spawn("b", park("b"), L, false)) as Pid;
          const ref = (yield fx.monitor(b, L)) as Ref;
          yield fx.sleep(1, L);
          yield fx.demonitor(ref, L, false);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.kill(r.whereis("b")!, "killed");
      r.flush();
      const a = r.whereis("a")!;
      const before = tagsOf(r, a);
      r.step(2);
      r.flush();
      return eq("[DOWN killed]", tagsOf(r, a), {
        before,
        after: tagsOf(r, a),
        step: "demonitor",
      });
    },
  },
  {
    id: "gs-call",
    group: "genserver",
    primitive: "gen_server:call",
    path: "gen_server/call/ok",
    title: "call 是 alias + Reply，不是裸 send/receive",
    erlang:
      "OTP 24+ gen:call: monitor(Pid, [{alias, demonitor}]). Reply 发给 alias。server 挂了会 DOWN。",
    run() {
      const r = rt();
      let reply: unknown = "";
      r.spawn("echo", startLink("echo", echo()), undefined, false);
      r.spawn(
        "client",
        function* () {
          yield fx.register("client", L);
          const pid = (yield fx.whereis("echo", L)) as Pid | null;
          reply = yield* call(pid!, "ping", L);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      return eq("pong", reply, {
        diagram: {
          left: { name: "client", live: true },
          right: { name: "echo", live: true },
          signal: "monitor · call · Reply",
        },
      });
    },
  },
  {
    id: "gs-call-crash",
    group: "genserver",
    primitive: "gen_server:call crash",
    path: "gen_server/call/crash",
    title: "server 在 call 中途死，client 拿到 DOWN 还活着",
    erlang: "这就是为什么 call 必须 monitor：否则 client 会永远卡在 receive。",
    run() {
      const r = rt();
      let err = "";
      r.spawn(
        "echo",
        function* () {
          yield fx.register("echo", L);
          yield fx.receive((m) => m.t === "Call", L);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const server = r.whereis("echo")!;
      r.spawn(
        "client",
        function* () {
          yield fx.register("client", L);
          try {
            yield* call(server, "ping", L, 50);
          } catch (e) {
            err = e instanceof Error ? e.message : String(e);
          }
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.kill(server, "killed");
      r.flush();
      r.step(60);
      r.flush();
      const client = r.whereis("client");
      return eq(
        "killed · client alive",
        `${err || "no-err"} · ${r.processes.get(client!)?.alive ? "client alive" : "client dead"}`,
        {
          diagram: {
            left: { name: "client", live: true },
            right: { name: "echo", live: false },
            signal: "DOWN → call fails",
          },
        },
      );
    },
  },
  {
    id: "gs-call-timeout",
    group: "genserver",
    primitive: "gen_server:call timeout",
    path: "gen_server/call/timeout",
    title: "超时后 alias 失活，迟到的 Reply 进不了邮箱",
    erlang:
      "EEP-53：timeout → demonitor → alias 死。已经进队列的 Reply 还能取；之后发给 alias 的 Reply 丢掉。这是 OTP 23 教科书 call 做不到的。",
    run() {
      const r = rt();
      let err = "";
      r.spawn(
        "echo",
        function* () {
          yield fx.register("echo", L);
          const m = (yield fx.receive((x) => x.t === "Call", L)) as Msg;
          yield fx.sleep(80, L);
          if (m.t === "Call") {
            yield fx.send(
              { alias: m.ref },
              { t: "Reply", ref: m.ref, reply: "pong" },
              L,
            );
          }
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const server = r.whereis("echo")!;
      r.spawn(
        "client",
        function* () {
          yield fx.register("client", L);
          try {
            yield* call(server, "ping", L, 20);
          } catch (e) {
            err = e instanceof Error ? e.message : String(e);
          }
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      r.step(30);
      r.flush();
      r.step(80);
      r.flush();
      const client = r.whereis("client")!;
      return eq(
        "timeout · []",
        `${err || "no-err"} · ${show(tagsOf(r, client))}`,
        {
          before: [],
          after: tagsOf(r, client),
          step: "late Reply dropped",
          diagram: {
            left: { name: "client", live: true },
            right: { name: "echo", live: true },
            signal: "alias dead → drop Reply",
          },
        },
      );
    },
  },
  {
    id: "gs-call-empty",
    group: "genserver",
    primitive: "gen_server:call empty",
    path: "gen_server/call/empty",
    title: "call 成功后 client 邮箱是空的，不会留下 DOWN",
    erlang:
      "server 回完就 normal 退出。client 收到 Reply 后 demonitor；monitor 已拆，没有 DOWN。邮箱 []。",
    run() {
      const r = rt();
      let reply: unknown = "";
      r.spawn(
        "echo",
        function* () {
          yield fx.register("echo", L);
          const m = (yield fx.receive((x) => x.t === "Call", L)) as Msg;
          if (m.t === "Call") {
            yield fx.send(
              { alias: m.ref },
              { t: "Reply", ref: m.ref, reply: "pong" },
              L,
            );
          }
        },
        undefined,
        false,
      );
      r.spawn(
        "client",
        function* () {
          yield fx.register("client", L);
          const pid = (yield fx.whereis("echo", L)) as Pid | null;
          reply = yield* call(pid!, "ping", L);
          yield fx.sleep(99999, L);
        },
        undefined,
        false,
      );
      r.flush();
      const client = r.whereis("client")!;
      return eq(
        "pong · []",
        `${reply} · ${show(tagsOf(r, client))}`,
        {
          after: tagsOf(r, client),
          diagram: {
            left: { name: "client", live: true },
            right: { name: "echo", live: false },
            signal: "Reply · demonitor · no DOWN",
          },
        },
      );
    },
  },
  {
    id: "gs-cast",
    group: "genserver",
    primitive: "gen_server:cast",
    path: "gen_server/cast",
    title: "cast 不等待，发完即走",
    erlang: "gen_server:cast(Pid, Msg) 是 send，没有 monitor，没有 reply。",
    run() {
      const r = rt();
      const seen: unknown[] = [];
      r.spawn(
        "echo",
        startLink("echo", {
          init: () => null,
          handleCall: (req, _f, state) => ({ reply: req, state }),
          handleCast: (req, state) => {
            seen.push(req);
            return state;
          },
        }),
        undefined,
        false,
      );
      r.flush();
      const pid = r.whereis("echo")!;
      r.inject(pid, { t: "Cast", req: "nudge" });
      r.flush();
      return eq("[nudge]", show(seen));
    },
  },
];

export function runCase(c: SemCase): SemResult {
  try {
    return c.run();
  } catch (err) {
    return {
      ok: false,
      want: "no throw",
      got: err instanceof Error ? err.message : String(err),
    };
  }
}

export function otpDump(): { id: string; got: string; ok: boolean }[] {
  return OTP_IDS.map((id) => {
    const c = CASES.find((x) => x.id === id);
    if (!c) return { id, got: "missing", ok: false };
    const r = runCase(c);
    return { id, got: r.got, ok: r.ok };
  });
}

