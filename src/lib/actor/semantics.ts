import { Runtime } from "./runtime.ts";
import { simpleOneForOne, supervise } from "./supervisor.ts";
import {
  fx,
  term,
  type MenuItem,
  type Msg,
  type Pid,
  type ProcFn,
} from "./types.ts";

const L = "semantics.ml:run";

export type SemGroup = "primitive" | "mailbox" | "link" | "supervisor";

export type SemResult = {
  ok: boolean;
  want: string;
  got: string;
  before?: string[];
  after?: string[];
  taken?: string;
};

export type SemCase = {
  id: string;
  group: SemGroup;
  primitive: string;
  title: string;
  erlang: string;
  run: () => SemResult;
};

export const GROUP_LABEL: Record<SemGroup, string> = {
  primitive: "原语",
  mailbox: "邮箱",
  link: "链接 / 退出",
  supervisor: "监督树",
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
  return p.mailbox.map((m) => (m.t === "Term" ? m.tag : m.t));
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
      return eq(0, alive);
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
      return eq(["killed", true].join(" "), [reason, sup.alive].join(" "));
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

export function runAll(): { id: string; result: SemResult }[] {
  return CASES.map((c) => ({ id: c.id, result: runCase(c) }));
}
