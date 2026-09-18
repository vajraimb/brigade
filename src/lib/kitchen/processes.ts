import { fx, type MenuItem, type Msg, type Pid, type ProcFn, type Station } from "../actor/types";

type ChildSpec = {
  id: string;
  start: ProcFn;
  restart: "permanent" | "transient" | "temporary";
};

type ChildRow = { spec: ChildSpec; pid: Pid; hist: number[] };

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

function supervise(opts: {
  name: string;
  specs: ChildSpec[];
  intensity?: number;
  period?: number;
}): ProcFn {
  const intensity = opts.intensity ?? 6;
  const period = opts.period ?? 12000;
  return function* () {
    yield fx.register(opts.name, "supervisor.ml:register");
    yield fx.trap_exit(true, "supervisor.ml:trap_exit");
    const children: ChildRow[] = [];
    for (const spec of opts.specs) {
      const pid = (yield fx.spawn(
        spec.id,
        spec.start,
        "supervisor.ml:spawn",
        true,
      )) as Pid;
      children.push({ spec, pid, hist: [] });
    }
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "EXIT" || m.t === "Crash",
        "supervisor.ml:receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("supervisor abort");
      if (msg.t !== "EXIT") continue;
      const idx = children.findIndex((c) => c.pid === msg.pid);
      if (idx < 0) continue;
      const row = children[idx]!;
      const skip =
        row.spec.restart === "temporary" ||
        (row.spec.restart === "transient" && msg.reason === "normal");
      if (skip) {
        children.splice(idx, 1);
        continue;
      }
      const t = (yield fx.now("supervisor.ml:intensity")) as number;
      row.hist = [t, ...row.hist.filter((h) => t - h <= period)];
      if (row.hist.length > intensity) throw new Error("intensity exceeded");
      const pid = (yield fx.spawn(
        row.spec.id,
        row.spec.start,
        "supervisor.ml:restart",
        true,
      )) as Pid;
      row.pid = pid;
    }
  };
}

function simpleOneForOne(name: string): ProcFn {
  return function* () {
    yield fx.register(name, "supervisor.ml:sofs.register");
    yield fx.trap_exit(true, "supervisor.ml:sofs.trap_exit");
    let n = 1;
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "StartChild" || m.t === "EXIT" || m.t === "Crash",
        "supervisor.ml:sofs.receive",
      )) as Msg;
      if (msg.t === "Crash") throw new Error("service abort");
      if (msg.t === "StartChild") {
        const id = `order-${n++}-${msg.item.id}`;
        yield fx.spawn(id, order(msg.item), "supervisor.ml:sofs.spawn", true);
      }
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
  return simpleOneForOne("service_sup");
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
