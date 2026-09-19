import { fx, type MenuItem, type Msg, type Pid, type ProcFn, type Station } from "../actor/types.ts";
import { simpleOneForOne, supervise } from "../actor/supervisor.ts";

function cook(station: Station): ProcFn {
  return function* () {
    yield fx.register(station, "kitchen.ml:cook.register");
    while (true) {
      const msg = (yield fx.receive(
        (m) => (m.t === "Ticket" && m.station === station) || m.t === "Crash",
        "kitchen.ml:cook.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("pan on fire");
      if (msg.t === "Ticket" && msg.poison) throw new Error("poison ticket");
      if (msg.t === "Ticket") {
        yield fx.sleep(msg.cookMs, "kitchen.ml:cook.sleep");
        yield fx.send(
          "pass",
          { t: "Plated", id: msg.id, item: msg.item, order: msg.order },
          "kitchen.ml:cook.send",
        );
      }
    }
  };
}

function pass(): ProcFn {
  return function* () {
    yield fx.register("pass", "kitchen.ml:pass.register");
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "Plated" || m.t === "Crash",
        "kitchen.ml:pass.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("pass down");
      if (msg.t === "Plated") {
        yield fx.sleep(280, "kitchen.ml:pass.sleep");
        yield fx.send(
          msg.order,
          { t: "Ready", id: msg.id, item: msg.item, order: msg.order },
          "kitchen.ml:pass.send",
        );
      }
    }
  };
}

function order(item: MenuItem): ProcFn {
  return function* () {
    const me = (yield fx.self("kitchen.ml:order.self")) as Pid;
    for (let n = 1; n <= 3; n++) {
      const cookPid = (yield fx.whereis(
        item.station,
        "kitchen.ml:order.whereis",
      )) as Pid | null;
      if (cookPid == null) {
        yield fx.sleep(400, "kitchen.ml:order.wait");
        continue;
      }
      yield fx.send(
        cookPid,
        {
          t: "Ticket",
          id: 0,
          station: item.station,
          item: item.name,
          order: me,
          poison: item.poison,
          cookMs: item.cookMs,
        },
        "kitchen.ml:order.send",
      );
      const got = (yield fx.receive(
        (m) => m.t === "Ready" && m.order === me,
        "kitchen.ml:order.receive",
        4000,
      )) as Msg;
      if (got.t === "Ready") return;
      yield fx.sleep(300, "kitchen.ml:order.retry");
    }
  };
}

export function lineSup(): ProcFn {
  return supervise({
    name: "line_sup",
    specs: [
      { id: "grill", start: cook("grill"), restart: "permanent" },
      { id: "fry", start: cook("fry"), restart: "permanent" },
      { id: "pass", start: pass(), restart: "permanent" },
    ],
  });
}

export function serviceSup(): ProcFn {
  return simpleOneForOne("service_sup", (item, n) => ({
    id: `order-${n}-${item.id}`,
    fn: order(item),
  }));
}

export function brigade(): ProcFn {
  return supervise({
    name: "brigade_sup",
    specs: [
      { id: "line_sup", start: lineSup(), restart: "permanent" },
      { id: "service_sup", start: serviceSup(), restart: "permanent" },
    ],
  });
}

export function orderCount(names: Iterable<string>): number {
  let n = 0;
  for (const name of names) if (name.startsWith("order-")) n += 1;
  return n;
}
