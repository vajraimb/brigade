import type { Pid, Ref } from "../actor/types.ts";

export type Presence = "alive" | "busy" | "restarting" | "degraded" | "offline";
export type Kind = "agent" | "tool" | "human";
export type DeliveryState =
  | "accepted"
  | "routed"
  | "delivered"
  | "acked"
  | "rejected"
  | "timed_out"
  | "cancelled"
  | "failed";

export type FailureReason =
  | "no_route"
  | "recipient_down"
  | "mailbox_overflow"
  | "ack_deadline"
  | "rejected"
  | "internal";

export type Behavior = "ack" | "hang" | "crash" | "slow" | "gate";
export type AckOutcome = "ok" | "rejected";
export type WaitResult =
  | "acked"
  | "timeout"
  | "down"
  | "cancelled"
  | "rejected"
  | "failed";

export type ParticipantSpec = {
  id: string;
  kind: Kind;
  behavior?: Behavior;
  slowMs?: number;
};

export type Payload =
  | { t: "chat"; text: string }
  | { t: "command"; name: string }
  | { t: "system"; name: string; detail?: string };

export type Envelope = {
  msgId: string;
  deliveryId: string;
  roomId: string;
  from: string;
  to: string | null;
  ackRequired: boolean;
  deadlineMs?: number;
  replyRef?: Ref;
  generation: number;
  payload: Payload;
};

export type AckPayload = {
  deliveryId: string;
  from: string;
  generation: number;
  outcome?: AckOutcome;
};

export type Delivery = {
  id: string;
  msgId: string;
  from: string;
  to: string;
  state: DeliveryState;
  reason?: FailureReason;
  createdAt: number;
  replyRef?: Ref;
  generation: number;
  destPid?: Pid;
};

export type AmrEvent = {
  at: number;
  name: string;
  detail: string;
};

export type ParticipantRow = {
  id: string;
  kind: Kind;
  pid: Pid | null;
  presence: Presence;
  behavior: Behavior;
  restarts: number;
  generation: number;
};

export type AmrStore = {
  roomId: string;
  participants: Map<string, ParticipantRow>;
  deliveries: Map<string, Delivery>;
  events: AmrEvent[];
  seq: number;
  mailboxCap: number;
};

export const MAILBOX_CAP = 8;

export function emptyStore(roomId = "war-1"): AmrStore {
  return {
    roomId,
    participants: new Map(),
    deliveries: new Map(),
    events: [],
    seq: 1,
    mailboxCap: MAILBOX_CAP,
  };
}

export function note(store: AmrStore, at: number, name: string, detail: string) {
  store.events.unshift({ at, name, detail });
  if (store.events.length > 80) store.events.length = 80;
}

export function isTerminal(state: DeliveryState): boolean {
  return (
    state === "acked" ||
    state === "rejected" ||
    state === "timed_out" ||
    state === "cancelled" ||
    state === "failed"
  );
}

export function pendingTo(store: AmrStore, to: string): number {
  let n = 0;
  for (const d of store.deliveries.values()) {
    if (d.to === to && !isTerminal(d.state)) n += 1;
  }
  return n;
}

export const DEMO: ParticipantSpec[] = [
  { id: "planner", kind: "agent", behavior: "ack" },
  { id: "researcher", kind: "agent", behavior: "ack" },
  { id: "browser", kind: "tool", behavior: "slow", slowMs: 120 },
  { id: "reviewer", kind: "human", behavior: "ack" },
];
