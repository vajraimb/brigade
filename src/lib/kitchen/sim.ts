import { Runtime } from "../actor/runtime";
import type { MenuItem, Pid, Snapshot } from "../actor/types";
import { brigade } from "./processes";

export const MAX_ORDERS = 7;

export class KitchenSim {
  runtime: Runtime;
  private rootDiedAt: number | null = null;

  constructor(opts: { deliveryMs?: number } = {}) {
    this.runtime = new Runtime(opts);
    this.boot();
  }

  private boot() {
    this.runtime.spawn("brigade_sup", brigade());
    this.runtime.flush();
    this.rootDiedAt = null;
  }

  tick(dtMs: number) {
    this.runtime.step(dtMs);
    const rootAlive = [...this.runtime.processes.values()].some(
      (p) => p.name === "brigade_sup" && p.alive,
    );
    if (!rootAlive) {
      if (this.rootDiedAt == null) this.rootDiedAt = this.runtime.now;
      else if (this.runtime.now - this.rootDiedAt > 800) this.boot();
    } else {
      this.rootDiedAt = null;
    }
  }

  snapshot(): Snapshot {
    return this.runtime.snapshot();
  }

  liveOrders(): number {
    let n = 0;
    for (const p of this.runtime.processes.values()) {
      if (p.alive && p.name.startsWith("order-")) n += 1;
    }
    return n;
  }

  placeOrder(item: MenuItem): boolean {
    if (this.liveOrders() >= MAX_ORDERS) return false;
    const pid = this.runtime.whereis("service_sup");
    if (pid == null) return false;
    this.runtime.inject(pid, { t: "StartChild", item, key: item.id });
    this.runtime.flush();
    return true;
  }

  crash(pid: Pid) {
    this.runtime.kill(pid, "killed");
    this.runtime.flush();
  }

  crashName(name: string) {
    const pid = this.runtime.whereis(name);
    if (pid != null) this.crash(pid);
  }
}
