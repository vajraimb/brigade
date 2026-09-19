import { fx, term, type Msg, type Pid, type ProcFn, type Ref } from "../actor/types.ts";
import { Runtime } from "../actor/runtime.ts";
import { supervise } from "../actor/supervisor.ts";
import {
  isTerminal,
  note,
  type AmrStore,
  type Behavior,
  type Delivery,
  type Envelope,
  type Kind,
  type ParticipantSpec,
  type Payload,
  type Presence,
} from "./types.ts";

const L = "amr.ml:room.receive";

export type SendPayload = {
  from: string;
  to: string | null;
  payload: Payload;
  ackRequired?: boolean;
  deadlineMs?: number;
  replyRef?: Ref;
  msgId?: string;
};

export function restartOf(kind: Kind): "transient" | "temporary" {
  return kind === "human" ? "temporary" : "transient";
}

export function bootRoom(
  r: Runtime,
  store: AmrStore,
  specs: ParticipantSpec[],
) {
  r.spawn(
    "room_root_sup",
    supervise({
      name: "room_root_sup",
      strategy: "one_for_one",
      intensity: 12,
      specs: [
        { id: "room", start: roomProc(store), restart: "permanent" },
        { id: "event_log", start: eventLogProc(), restart: "permanent" },
        {
          id: "participant_sup",
          start: participantSupProc(store, specs),
          restart: "permanent",
        },
      ],
    }),
  );
  r.flush();
}

export function injectSend(r: Runtime, req: SendPayload) {
  const pid = r.whereis("room");
  if (pid != null) r.inject(pid, term("amr.send", req));
}

export function injectAck(r: Runtime, deliveryId: string, from: string) {
  const pid = r.whereis("room");
  if (pid != null) r.inject(pid, term("amr.ack", { deliveryId, from }));
}

export function injectCancel(r: Runtime, deliveryId: string) {
  const pid = r.whereis("room");
  if (pid != null) r.inject(pid, term("amr.cancel", { deliveryId }));
}

export function injectJoin(r: Runtime, spec: ParticipantSpec) {
  const pid = r.whereis("room");
  if (pid != null) r.inject(pid, term("amr.join", spec));
}

export function injectLeave(r: Runtime, id: string) {
  const pid = r.whereis("room");
  if (pid != null) r.inject(pid, term("amr.leave", { id }));
}

export function injectPresence(r: Runtime, id: string, presence: Presence) {
  const pid = r.whereis("room");
  if (pid != null) r.inject(pid, term("amr.presence", { id, presence }));
}

export function lastDelivery(store: AmrStore): Delivery | undefined {
  let last: Delivery | undefined;
  for (const d of store.deliveries.values()) last = d;
  return last;
}

/**
 * OTP 24+ gen:call shape, pointed at the room: monitor `{alias, demonitor}`,
 * send the envelope with replyRef, receive Reply | DOWN | timeout.
 * Timeout deactivates the alias; a late Ack→Reply is dropped like a dead Pid.
 */
export function* sendAndWaitAck(
  env: {
    from: string;
    to: string;
    payload: Payload;
    deadlineMs?: number;
  },
  timeout = 4000,
  loc = "amr.ml:wait_ack",
): Generator<import("../actor/types.ts").Effect, "acked" | "timeout" | "down", unknown> {
  const room = (yield fx.whereis("room", loc)) as Pid | null;
  if (room == null) return "down";
  const ref = (yield fx.monitor(room, loc, "demonitor")) as Ref;
  yield fx.send(
    room,
    term("amr.send", {
      from: env.from,
      to: env.to,
      payload: env.payload,
      ackRequired: true,
      deadlineMs: env.deadlineMs,
      replyRef: ref,
    } satisfies SendPayload),
    loc,
  );
  const m = (yield fx.receive(
    (x) =>
      (x.t === "Reply" && x.ref === ref) || (x.t === "DOWN" && x.ref === ref),
    loc,
    timeout,
    ref,
  )) as Msg;
  if (m.t === "Timeout") {
    yield fx.demonitor(ref, loc, true);
    const leftover = (yield fx.receive(
      (x) => x.t === "Reply" && x.ref === ref,
      loc,
      0,
    )) as Msg;
    if (leftover.t === "Reply") return "acked";
    return "timeout";
  }
  yield fx.demonitor(ref, loc, true);
  if (m.t === "Reply") return "acked";
  return "down";
}

function isRoomMsg(m: Msg): boolean {
  if (m.t === "EXIT" || m.t === "DOWN" || m.t === "Crash") return true;
  return m.t === "Term" && m.tag.startsWith("amr.");
}

function roomProc(store: AmrStore): ProcFn {
  return function* () {
    yield fx.register("room", "amr.ml:room.register");
    yield fx.trap_exit(true, "amr.ml:room.trap");
    while (true) {
      const msg = (yield fx.receive(isRoomMsg, L)) as Msg;
      if (msg.t === "Crash") throw new Error("room abort");
      if (msg.t === "EXIT") continue;
      if (msg.t === "DOWN") {
        yield* onDown(store, msg.pid, msg.reason);
        continue;
      }
      if (msg.t !== "Term") continue;
      switch (msg.tag) {
        case "amr.send":
          yield* onSend(store, msg.payload as SendPayload);
          break;
        case "amr.ack":
          yield* onAck(store, msg.payload as { deliveryId: string; from: string });
          break;
        case "amr.cancel":
          yield* onCancel(store, (msg.payload as { deliveryId: string }).deliveryId);
          break;
        case "amr.join":
          yield* onJoin(store, msg.payload as ParticipantSpec);
          break;
        case "amr.leave":
          yield* onLeave((msg.payload as { id: string }).id);
          break;
        case "amr.presence":
          yield* onPresence(
            store,
            msg.payload as { id: string; presence: Presence },
          );
          break;
        case "amr.hello":
          yield* onHello(store, (msg.payload as { id: string }).id);
          break;
        case "amr.deadline":
          yield* onDeadline(
            store,
            (msg.payload as { deliveryId: string }).deliveryId,
          );
          break;
        default:
          break;
      }
    }
  };
}

function* onSend(store: AmrStore, req: SendPayload) {
  const targets =
    req.to == null
      ? [...store.participants.keys()].filter((id) => id !== req.from)
      : [req.to];
  for (const to of targets) yield* routeOne(store, req, to);
}

function* routeOne(store: AmrStore, req: SendPayload, to: string) {
  const now = (yield fx.now("amr.ml:room.route")) as number;
  const id = `d${store.seq++}`;
  const msgId = req.msgId ?? `m${store.seq++}`;
  const d: Delivery = {
    id,
    msgId,
    from: req.from,
    to,
    state: "accepted",
    createdAt: now,
    replyRef: req.replyRef,
  };
  store.deliveries.set(id, d);
  note(store, now, "accepted", `${req.from} → ${to}`);

  const row = store.participants.get(to);
  const pid = (yield fx.whereis(to, "amr.ml:room.route")) as Pid | null;
  if (pid == null || row?.presence === "offline") {
    d.state = "failed";
    d.reason = row ? "recipient_down" : "no_route";
    note(store, now, "failed", `${to} ${d.reason}`);
    return;
  }

  d.state = "routed";
  const env: Envelope = {
    msgId,
    deliveryId: id,
    roomId: store.roomId,
    from: req.from,
    to,
    ackRequired: req.ackRequired !== false,
    deadlineMs: req.deadlineMs,
    replyRef: req.replyRef,
    payload: req.payload,
  };
  yield fx.send(pid, term("amr.deliver", env), "amr.ml:room.route");
  d.state = "delivered";
  note(store, now, "delivered", `${req.from} → ${to} ${id}`);

  if (env.ackRequired && (req.deadlineMs ?? 0) > 0) {
    yield fx.spawn(
      `timer:${id}`,
      deadlineProc(id, req.deadlineMs!),
      "amr.ml:room.timer",
      false,
    );
  }
}

function deadlineProc(deliveryId: string, ms: number): ProcFn {
  return function* () {
    yield fx.sleep(ms, "amr.ml:timer.sleep");
    const room = (yield fx.whereis("room", "amr.ml:timer.sleep")) as Pid | null;
    if (room != null) {
      yield fx.send(
        room,
        term("amr.deadline", { deliveryId }),
        "amr.ml:timer.sleep",
      );
    }
  };
}

function* onAck(store: AmrStore, req: { deliveryId: string; from: string }) {
  const now = (yield fx.now("amr.ml:room.reply")) as number;
  const d = store.deliveries.get(req.deliveryId);
  if (!d) return;
  if (isTerminal(d.state)) {
    note(store, now, "drop", `late ack ${d.id}`);
    return;
  }
  d.state = "acked";
  note(store, now, "acked", `${req.from} ${d.id}`);
  if (d.replyRef != null) {
    yield fx.send(
      { alias: d.replyRef },
      { t: "Reply", ref: d.replyRef, reply: "acked" },
      "amr.ml:room.reply",
    );
  }
}

function* onCancel(store: AmrStore, deliveryId: string) {
  const now = (yield fx.now("amr.ml:room.reply")) as number;
  const d = store.deliveries.get(deliveryId);
  if (!d || isTerminal(d.state)) return;
  d.state = "cancelled";
  note(store, now, "cancelled", d.id);
}

function* onDeadline(store: AmrStore, deliveryId: string) {
  const now = (yield fx.now("amr.ml:room.reply")) as number;
  const d = store.deliveries.get(deliveryId);
  if (!d || isTerminal(d.state)) return;
  d.state = "timed_out";
  d.reason = "ack_deadline";
  note(store, now, "timed_out", d.id);
}

function* onJoin(store: AmrStore, spec: ParticipantSpec) {
  if (!store.participants.has(spec.id)) {
    store.participants.set(spec.id, rowOf(spec));
  }
  yield fx.send("participant_sup", term("amr.spawn_p", spec), "amr.ml:room.route");
}

function* onLeave(id: string) {
  yield fx.send("participant_sup", term("amr.stop_p", { id }), "amr.ml:room.leave");
}

function* onPresence(
  store: AmrStore,
  req: { id: string; presence: Presence },
) {
  const row = store.participants.get(req.id);
  if (!row) return;
  const now = (yield fx.now("amr.ml:room.reply")) as number;
  row.presence = req.presence;
  note(store, now, "presence", `${req.id} ${req.presence}`);
}

function* onHello(store: AmrStore, id: string) {
  const now = (yield fx.now("amr.ml:room.monitor")) as number;
  const pid = (yield fx.whereis(id, "amr.ml:room.monitor")) as Pid | null;
  const row = store.participants.get(id);
  if (!row) return;
  const prev = row.pid;
  row.pid = pid;
  if (pid != null) yield fx.monitor(pid, "amr.ml:room.monitor");
  if (row.presence === "restarting" || (prev != null && prev !== pid)) {
    row.restarts += 1;
    row.presence = "alive";
    note(store, now, "restarted", `${id} #${pid}`);
  } else {
    row.presence = "alive";
    note(store, now, "join", `${id} #${pid}`);
  }
}

function* onDown(store: AmrStore, pid: Pid, reason: string) {
  const now = (yield fx.now("amr.ml:room.monitor")) as number;
  const row = [...store.participants.values()].find((p) => p.pid === pid);
  if (!row) return;
  row.pid = null;
  const crashing = reason !== "normal";
  row.presence = crashing && row.kind !== "human" ? "restarting" : "offline";
  note(store, now, "down", `${row.id} ${reason}`);
  for (const d of store.deliveries.values()) {
    if (d.to === row.id && !isTerminal(d.state)) {
      d.state = "failed";
      d.reason = "recipient_down";
      note(store, now, "failed", `${d.id} recipient_down`);
    }
  }
}

function eventLogProc(): ProcFn {
  return function* () {
    yield fx.register("event_log", "amr.ml:log.register");
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "Crash" || (m.t === "Term" && m.tag === "amr.event"),
        "amr.ml:log.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("event_log abort");
    }
  };
}

function participantSupProc(store: AmrStore, initial: ParticipantSpec[]): ProcFn {
  return function* () {
    yield fx.register("participant_sup", "amr.ml:psup.register");
    yield fx.trap_exit(true, "amr.ml:psup.trap");
    type Child = {
      spec: ParticipantSpec;
      pid: Pid;
      restart: "transient" | "temporary";
    };
    const children: Child[] = [];
    for (const spec of initial) {
      store.participants.set(spec.id, rowOf(spec));
      const pid = (yield fx.spawn(
        spec.id,
        participantProc(spec),
        "amr.ml:psup.spawn",
        true,
      )) as Pid;
      children.push({ spec, pid, restart: restartOf(spec.kind) });
    }
    while (true) {
      const msg = (yield fx.receive(
        (m) =>
          m.t === "EXIT" ||
          m.t === "Crash" ||
          (m.t === "Term" &&
            (m.tag === "amr.spawn_p" || m.tag === "amr.stop_p")),
        "amr.ml:psup.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("participant_sup abort");
      if (msg.t === "Term" && msg.tag === "amr.spawn_p") {
        const spec = msg.payload as ParticipantSpec;
        if (children.some((c) => c.spec.id === spec.id)) continue;
        if (!store.participants.has(spec.id)) {
          store.participants.set(spec.id, rowOf(spec));
        }
        const pid = (yield fx.spawn(
          spec.id,
          participantProc(spec),
          "amr.ml:psup.spawn",
          true,
        )) as Pid;
        children.push({ spec, pid, restart: restartOf(spec.kind) });
      } else if (msg.t === "Term" && msg.tag === "amr.stop_p") {
        const id = (msg.payload as { id: string }).id;
        const row = children.find((c) => c.spec.id === id);
        if (row) {
          row.restart = "temporary";
          yield fx.exit_pid(row.pid, "shutdown", "amr.ml:psup.stop");
        }
      } else if (msg.t === "EXIT") {
        const idx = children.findIndex((c) => c.pid === msg.pid);
        if (idx < 0) continue;
        const row = children[idx]!;
        const skip =
          row.restart === "temporary" ||
          (row.restart === "transient" && msg.reason === "normal");
        if (skip) {
          children.splice(idx, 1);
          continue;
        }
        const pid = (yield fx.spawn(
          row.spec.id,
          participantProc(row.spec),
          "amr.ml:psup.restart",
          true,
        )) as Pid;
        row.pid = pid;
        const p = store.participants.get(row.spec.id);
        if (p) p.presence = "restarting";
      }
    }
  };
}

function participantProc(spec: ParticipantSpec): ProcFn {
  const behavior: Behavior = spec.behavior ?? "ack";
  return function* () {
    yield fx.register(spec.id, "amr.ml:p.register");
    const room = (yield fx.whereis("room", "amr.ml:p.whereis")) as Pid | null;
    if (room != null) {
      yield fx.send(room, term("amr.hello", { id: spec.id }), "amr.ml:p.hello");
    }
    while (true) {
      const msg = (yield fx.receive(
        (m) =>
          m.t === "Crash" ||
          (m.t === "Term" &&
            (m.tag === "amr.deliver" || m.tag === "amr.stop")),
        "amr.ml:p.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("participant abort");
      if (msg.t === "Term" && msg.tag === "amr.stop") {
        yield fx.exit("normal", "amr.ml:p.leave");
        return;
      }
      if (msg.t === "Term" && msg.tag === "amr.deliver") {
        const env = msg.payload as Envelope;
        if (behavior === "crash") throw new Error("participant crash");
        if (behavior === "hang") {
          yield fx.sleep(99999, "amr.ml:p.hang");
          continue;
        }
        if (behavior === "slow") {
          yield fx.sleep(spec.slowMs ?? 120, "amr.ml:p.slow");
        }
        if (room != null) {
          yield fx.send(
            room,
            term("amr.ack", { deliveryId: env.deliveryId, from: spec.id }),
            "amr.ml:p.ack",
          );
        }
      }
    }
  };
}

function rowOf(spec: ParticipantSpec) {
  return {
    id: spec.id,
    kind: spec.kind,
    pid: null as Pid | null,
    presence: "offline" as Presence,
    behavior: (spec.behavior ?? "ack") as Behavior,
    restarts: 0,
  };
}
