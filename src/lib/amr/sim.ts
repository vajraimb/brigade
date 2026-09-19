import { Runtime } from "../actor/runtime.ts";
import type { Pid, Snapshot } from "../actor/types.ts";
import {
  bootRoom,
  injectCancel,
  injectJoin,
  injectLeave,
  injectPresence,
  injectSend,
  lastDelivery,
} from "./room.ts";
import {
  DEMO,
  emptyStore,
  type AmrEvent,
  type AmrStore,
  type Delivery,
  type ParticipantRow,
  type ParticipantSpec,
  type Presence,
} from "./types.ts";

export type AmrSnap = {
  actor: Snapshot;
  roomId: string;
  now: number;
  participants: ParticipantRow[];
  deliveries: Delivery[];
  events: AmrEvent[];
};

export class AmrSim {
  runtime: Runtime;
  store: AmrStore;
  private rootDiedAt: number | null = null;

  constructor(opts: { deliveryMs?: number } = {}) {
    this.runtime = new Runtime({ deliveryMs: opts.deliveryMs ?? 180 });
    this.store = emptyStore();
    this.boot();
  }

  private boot() {
    this.store = emptyStore();
    bootRoom(this.runtime, this.store, DEMO);
    this.rootDiedAt = null;
  }

  tick(dtMs: number) {
    this.runtime.step(dtMs);
    const rootAlive = [...this.runtime.processes.values()].some(
      (p) => p.name === "room_root_sup" && p.alive,
    );
    if (!rootAlive) {
      if (this.rootDiedAt == null) this.rootDiedAt = this.runtime.now;
      else if (this.runtime.now - this.rootDiedAt > 800) this.boot();
    } else {
      this.rootDiedAt = null;
    }
  }

  snapshot(): AmrSnap {
    return {
      actor: this.runtime.snapshot(),
      roomId: this.store.roomId,
      now: this.runtime.now,
      participants: [...this.store.participants.values()].map((p) => ({ ...p })),
      deliveries: [...this.store.deliveries.values()].map((d) => ({ ...d })).reverse(),
      events: this.store.events.slice(),
    };
  }

  send(from: string, to: string | null, text = "ping", deadlineMs = 900) {
    injectSend(this.runtime, {
      from,
      to,
      payload: { t: "chat", text },
      ackRequired: true,
      deadlineMs,
    });
    this.runtime.flush();
  }

  cancelLast() {
    const d = lastDelivery(this.store);
    if (!d) return;
    injectCancel(this.runtime, d.id);
    this.runtime.flush();
  }

  join(spec: ParticipantSpec) {
    injectJoin(this.runtime, spec);
    this.runtime.flush();
  }

  leave(id: string) {
    injectLeave(this.runtime, id);
    this.runtime.flush();
  }

  setPresence(id: string, presence: Presence) {
    injectPresence(this.runtime, id, presence);
    this.runtime.flush();
  }

  crash(pid: Pid) {
    this.runtime.kill(pid, "killed");
    this.runtime.flush();
  }

  crashName(name: string) {
    const pid = this.runtime.whereis(name);
    if (pid != null) this.crash(pid);
  }

  timeoutDrill() {
    if (!this.store.participants.has("scout")) {
      this.join({ id: "scout", kind: "tool", behavior: "hang" });
    }
    this.send("planner", "scout", "probe", 500);
  }
}
