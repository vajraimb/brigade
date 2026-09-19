import { Runtime } from "../actor/runtime.ts";
import { fx, type Pid } from "../actor/types.ts";
import type { SemCase, SemResult } from "../actor/semantics.ts";
import {
  bootRoom,
  injectCancel,
  injectJoin,
  injectLeave,
  injectPresence,
  injectSend,
  lastDelivery,
  sendAndWaitAck,
} from "./room.ts";
import { emptyStore, type AmrStore, type ParticipantSpec } from "./types.ts";

const L = "amr.ml:wait_ack";

function rt() {
  return new Runtime({ deliveryMs: 0 });
}

function setup(specs: ParticipantSpec[]) {
  const r = rt();
  const store = emptyStore();
  bootRoom(r, store, specs);
  return { r, store };
}

function pair() {
  return setup([
    { id: "a", kind: "agent", behavior: "ack" },
    { id: "b", kind: "agent", behavior: "ack" },
  ]);
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
    if (m.t === "Reply") return `Reply ${String(m.reply)}`;
    return m.t;
  });
}

function names(store: AmrStore, name: string): string[] {
  return store.events.filter((e) => e.name === name).map((e) => e.name);
}

function presenceOf(store: AmrStore, id: string) {
  return store.participants.get(id)?.presence ?? "missing";
}

function states(store: AmrStore): string[] {
  return [...store.deliveries.values()].map((d) => `${d.to}:${d.state}`);
}

const HI = { t: "chat" as const, text: "hi" };

export const AMR_CASES: SemCase[] = [
  {
    id: "amr-join-leave",
    group: "amr",
    primitive: "join / leave",
    path: "amr/room/join-leave",
    title: "join 后可见，leave 后不再路由",
    erlang:
      "join 把 participant 挂到 participant_sup 下；leave 是 shutdown + temporary，正常退出不重启。再发给已离开的 id → Failed。",
    run() {
      const { r, store } = setup([{ id: "a", kind: "agent", behavior: "ack" }]);
      injectJoin(r, { id: "b", kind: "agent", behavior: "ack" });
      r.flush();
      injectSend(r, { from: "a", to: "b", payload: HI });
      r.flush();
      const joined = lastDelivery(store)?.state;
      injectLeave(r, "b");
      r.flush();
      injectSend(r, { from: "a", to: "b", payload: HI });
      r.flush();
      const after = lastDelivery(store);
      return eq(
        "acked · failed",
        `${joined} · ${after?.state}`,
        {
          after: [presenceOf(store, "b"), after?.reason ?? ""],
          diagram: {
            left: { name: "a", live: true },
            right: { name: "b", live: false },
            signal: "leave → no_route",
          },
        },
      );
    },
  },
  {
    id: "amr-p2p",
    group: "amr",
    primitive: "send / ack",
    path: "amr/delivery/acked",
    title: "点对点 send，处理完成后 Acked",
    erlang:
      "Delivered ≠ Acked。放进 mailbox 只是送达；processing ack 才把 delivery 推到 Acked。",
    run() {
      const { r, store } = pair();
      injectSend(r, { from: "a", to: "b", payload: HI, ackRequired: true });
      r.flush();
      const d = lastDelivery(store);
      return eq("acked", d?.state, {
        after: states(store),
        diagram: {
          left: { name: "a", live: true },
          right: { name: "b", live: true },
          signal: "deliver → ack",
        },
      });
    },
  },
  {
    id: "amr-broadcast",
    group: "amr",
    primitive: "broadcast",
    path: "amr/delivery/broadcast",
    title: "发给 room，每个在场 participant 一份 delivery",
    erlang:
      "to = None 是广播。每人一条 delivery，各自 ack。不是一条消息被多人 pop。",
    run() {
      const { r, store } = setup([
        { id: "a", kind: "agent", behavior: "ack" },
        { id: "b", kind: "agent", behavior: "ack" },
        { id: "c", kind: "agent", behavior: "ack" },
      ]);
      injectSend(r, { from: "a", to: null, payload: HI });
      r.flush();
      const got = [...store.deliveries.values()]
        .map((d) => `${d.to}:${d.state}`)
        .sort();
      return eq(["b:acked", "c:acked"], got);
    },
  },
  {
    id: "amr-down",
    group: "amr",
    primitive: "monitor / DOWN",
    path: "amr/participant/down",
    title: "human participant 崩溃，room 收到 Down，不拉起",
    erlang:
      "human 是 temporary。room monitor 到 DOWN，presence = offline。不重启。",
    run() {
      const { r, store } = setup([
        { id: "a", kind: "agent", behavior: "ack" },
        { id: "h", kind: "human", behavior: "ack" },
      ]);
      const pid = r.whereis("h")!;
      r.kill(pid, "killed");
      r.flush();
      return eq(
        "offline · down",
        `${presenceOf(store, "h")} · ${names(store, "down")[0] ?? "none"}`,
        {
          diagram: {
            left: { name: "room", live: true },
            right: { name: "h", live: false },
            signal: "DOWN killed",
          },
        },
      );
    },
  },
  {
    id: "amr-restart",
    group: "amr",
    primitive: "transient restart",
    path: "amr/participant/restart",
    title: "agent 异常退出后被拉起，room 收到 Restarted",
    erlang:
      "agent/tool 是 transient：异常重启，normal 不重启。hello 带着新 Pid，room 记 Restarted。",
    run() {
      const { r, store } = pair();
      const before = r.whereis("b")!;
      r.kill(before, "killed");
      r.flush();
      const after = r.whereis("b");
      const row = store.participants.get("b");
      return eq(
        "alive · restarted · new-pid",
        `${row?.presence} · ${names(store, "restarted")[0] ?? "none"} · ${
          after != null && after !== before ? "new-pid" : `same:${after}`
        }`,
        {
          diagram: {
            left: { name: "psup", live: true },
            right: { name: "b", live: true },
            signal: "EXIT → spawn",
          },
        },
      );
    },
  },
  {
    id: "amr-timeout",
    group: "amr",
    primitive: "ack deadline",
    path: "amr/delivery/timeout",
    title: "不回 ack，delivery 进入 Timed_out",
    erlang:
      "room 给每条 ack_required 的投递 spawn 一个 timer。到期时若还不是终态，标 Timed_out。",
    run() {
      const { r, store } = setup([
        { id: "a", kind: "agent", behavior: "ack" },
        { id: "b", kind: "agent", behavior: "hang" },
      ]);
      injectSend(r, {
        from: "a",
        to: "b",
        payload: HI,
        ackRequired: true,
        deadlineMs: 20,
      });
      r.flush();
      r.step(30);
      r.flush();
      return eq("timed_out", lastDelivery(store)?.state, {
        after: [lastDelivery(store)?.reason ?? ""],
      });
    },
  },
  {
    id: "amr-late-ack",
    group: "amr",
    primitive: "alias / late ack drop",
    path: "amr/delivery/late-ack",
    title: "超时后迟到的 ack 必须被丢掉",
    erlang:
      "delivery 一旦 Timed_out / Cancelled / Failed，迟到 ack 不能再变成 Acked。send_and_wait_ack 的 alias 同时失活，Reply 进不了 caller 邮箱。两层同一条规则：死地址丢信。",
    run() {
      const { r, store } = setup([
        { id: "a", kind: "agent", behavior: "ack" },
        { id: "b", kind: "agent", behavior: "slow", slowMs: 80 },
      ]);
      let result = "";
      r.spawn(
        "client",
        function* () {
          yield fx.register("client", L);
          result = yield* sendAndWaitAck(
            { from: "a", to: "b", payload: HI, deadlineMs: 20 },
            25,
            L,
          );
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
      const d = lastDelivery(store);
      const client = r.whereis("client")!;
      const dropped = store.events.some((e) => e.name === "drop");
      return eq(
        "timed_out · timeout · [] · drop",
        `${d?.state} · ${result || "no-result"} · ${show(tagsOf(r, client))} · ${
          dropped ? "drop" : "no-drop"
        }`,
        {
          after: tagsOf(r, client),
          step: "late ack dropped",
          diagram: {
            left: { name: "client", live: true },
            right: { name: "b", live: true },
            signal: "alias dead → drop ack",
          },
        },
      );
    },
  },
  {
    id: "amr-cancel",
    group: "amr",
    primitive: "cancel",
    path: "amr/delivery/cancel",
    title: "取消后不得再转 Acked",
    erlang:
      "cancel 把 delivery 标成终态 Cancelled。之后 participant 的 processing ack 走同一条 late-drop 路径。",
    run() {
      const { r, store } = setup([
        { id: "a", kind: "agent", behavior: "ack" },
        { id: "b", kind: "agent", behavior: "slow", slowMs: 80 },
      ]);
      injectSend(r, {
        from: "a",
        to: "b",
        payload: HI,
        ackRequired: true,
        deadlineMs: 400,
      });
      r.flush();
      const id = lastDelivery(store)?.id;
      if (id) injectCancel(r, id);
      r.flush();
      r.step(80);
      r.flush();
      const d = lastDelivery(store);
      return eq(
        "cancelled · drop",
        `${d?.state} · ${store.events.some((e) => e.name === "drop") ? "drop" : "no-drop"}`,
      );
    },
  },
  {
    id: "amr-presence",
    group: "amr",
    primitive: "presence",
    path: "amr/presence/change",
    title: "Alive → Busy → Offline 发出 presence 事件",
    erlang:
      "presence 是 room 内状态，不是进程。系统事件和业务消息走同一条 note，不是旁路日志。",
    run() {
      const { r, store } = pair();
      injectPresence(r, "b", "busy");
      r.flush();
      injectPresence(r, "b", "offline");
      r.flush();
      const trail = store.events
        .filter((e) => e.name === "presence")
        .map((e) => e.detail)
        .reverse();
      return eq(["b busy", "b offline"], trail, {
        after: [presenceOf(store, "b")],
      });
    },
  },
  {
    id: "amr-no-route",
    group: "amr",
    primitive: "route failure",
    path: "amr/delivery/no-route",
    title: "不可达 participant 进入 Failed no_route",
    erlang:
      "whereis 不到目标：Failed no_route。mailbox overflow 是同一终态的另一种 reason，第一版只做路由失败。",
    run() {
      const { r, store } = pair();
      injectSend(r, { from: "a", to: "ghost", payload: HI });
      r.flush();
      const d = lastDelivery(store);
      return eq("failed · no_route", `${d?.state} · ${d?.reason}`);
    },
  },
];
