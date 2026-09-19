import type { Pid, Ref } from "../actor/types.ts";

export type Presence = "alive" | "busy" | "restarting" | "degraded" | "offline";
export type Kind = "agent" | "tool" | "human";
export type DeliveryState =
  | "accepted"
  | "routed"
  | "delivered"
  | "acked"
  | "timed_out"
  | "cancelled"
  | "failed";

export type FailureReason =
  | "no_route"
  | "recipient_down"
  | "mailbox_overflow"
  | "ack_deadline"
  | "internal";

export type Behavior = "ack" | "hang" | "crash" | "slow";

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
  payload: Payload;
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
};

export type AmrStore = {
  roomId: string;
  participants: Map<string, ParticipantRow>;
  deliveries: Map<string, Delivery>;
  events: AmrEvent[];
  seq: number;
};

export function emptyStore(roomId = "war-1"): AmrStore {
  return {
    roomId,
    participants: new Map(),
    deliveries: new Map(),
    events: [],
    seq: 1,
  };
}

export function note(store: AmrStore, at: number, name: string, detail: string) {
  store.events.unshift({ at, name, detail });
  if (store.events.length > 80) store.events.length = 80;
}

export function isTerminal(state: DeliveryState): boolean {
  return (
    state === "acked" ||
    state === "timed_out" ||
    state === "cancelled" ||
    state === "failed"
  );
}

export const DEMO: ParticipantSpec[] = [
  { id: "planner", kind: "agent", behavior: "ack" },
  { id: "researcher", kind: "agent", behavior: "ack" },
  { id: "browser", kind: "tool", behavior: "slow", slowMs: 120 },
  { id: "reviewer", kind: "human", behavior: "ack" },
];
