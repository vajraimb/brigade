import assert from "node:assert/strict";
import { test } from "node:test";
import { Runtime } from "./runtime.ts";
import { fx, type Msg, type Pid, type ProcFn } from "./types.ts";

function drive(rt: Runtime, ms: number, step = 16) {
  let t = 0;
  while (t < ms) {
    rt.step(step);
    t += step;
  }
}

test("spawn returns a pid and send/receive delivers", () => {
  const rt = new Runtime({ deliveryMs: 0 });
  const seen: string[] = [];
  const pong: ProcFn = function* () {
    const m = (yield fx.receive((x) => x.t === "Crash" || x.t === "Ready", "t:recv")) as Msg;
    if (m.t === "Ready") seen.push(m.item);
  };
  rt.spawn("ping", function* () {
    const pid = (yield fx.spawn("pong", pong, "t:spawn", false)) as Pid;
    yield fx.send(
      pid,
      { t: "Ready", id: 1, item: "Smash", order: 0 },
      "t:send",
    );
  });
  rt.flush();
  drive(rt, 50);
  assert.deepEqual(seen, ["Smash"]);
});

test("selective receive leaves unmatched mail", () => {
  const rt = new Runtime({ deliveryMs: 0 });
  let got = "";
  rt.spawn("box", function* () {
    yield fx.register("box", "t:reg");
    const m = (yield fx.receive(
      (x) => x.t === "Ready" && x.item === "Fries",
      "t:recv",
    )) as Msg;
    if (m.t === "Ready") got = m.item;
    yield fx.receive((x) => x.t === "Crash", "t:park");
  });
  rt.flush();
  const box = rt.whereis("box")!;
  rt.inject(box, { t: "Ready", id: 1, item: "Smash", order: 0 });
  rt.flush();
  const proc = rt.processes.get(box)!;
  assert.equal(proc.mailbox.length, 1);
  assert.equal(got, "");
  rt.inject(box, { t: "Ready", id: 2, item: "Fries", order: 0 });
  rt.flush();
  assert.equal(got, "Fries");
  assert.equal(proc.mailbox.length, 1);
});

test("crash notifies a trapping supervisor which restarts the child", () => {
  const rt = new Runtime({ deliveryMs: 0 });
  const worker: ProcFn = function* () {
    yield fx.register("grill", "t:reg");
    yield fx.receive((m) => m.t === "Crash", "t:recv");
    throw new Error("pan on fire");
  };
  rt.spawn("sup", function* () {
    yield fx.register("sup", "t:reg");
    yield fx.trap_exit(true, "t:trap");
    let child = (yield fx.spawn("grill", worker, "t:spawn", true)) as Pid;
    while (true) {
      const m = (yield fx.receive((x) => x.t === "EXIT", "t:exit")) as Msg;
      if (m.t === "EXIT" && m.pid === child) {
        child = (yield fx.spawn("grill", worker, "t:restart", true)) as Pid;
      }
    }
  });
  rt.flush();
  const first = rt.whereis("grill");
  assert.ok(first);
  rt.kill(first, "killed");
  rt.flush();
  const second = rt.whereis("grill");
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(rt.processes.get(rt.whereis("sup")!)?.alive, true);
});

test("killing a linked process without trap_exit cascades", () => {
  const rt = new Runtime({ deliveryMs: 0 });
  rt.spawn("a", function* () {
    yield fx.spawn("b", function* () {
      yield fx.receive((m) => m.t === "Crash", "t");
    }, "t:spawn", true);
    yield fx.receive((m) => m.t === "Crash", "t");
  });
  rt.flush();
  const a = [...rt.processes.values()].find((p) => p.name === "a")!;
  rt.kill(a.pid, "killed");
  rt.flush();
  const alive = [...rt.processes.values()].filter((p) => p.alive);
  assert.equal(alive.length, 0);
});
