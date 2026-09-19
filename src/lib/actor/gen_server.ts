import { fx, type Msg, type Pid, type ProcFn, type Ref } from "./types.ts";

export type Callback<S = unknown, Req = unknown, Rep = unknown> = {
  init: () => S;
  handleCall: (req: Req, from: Pid, state: S) => { reply: Rep; state: S };
  handleCast?: (req: Req, state: S) => S;
};

const L = "gen_server.ml:loop";

export function startLink<S, Req, Rep>(
  name: string,
  cb: Callback<S, Req, Rep>,
): ProcFn {
  return function* () {
    yield fx.register(name, "gen_server.ml:register");
    let state = cb.init();
    while (true) {
      const msg = (yield fx.receive(
        (m) => m.t === "Call" || m.t === "Cast" || m.t === "Crash",
        L,
      )) as Msg;
      if (msg.t === "Crash") throw new Error("gen_server abort");
      if (msg.t === "Call") {
        const out = cb.handleCall(msg.req as Req, msg.from, state);
        state = out.state;
        // OTP 24+ gen:reply sends to the alias, not the Pid.
        yield fx.send(
          { alias: msg.ref },
          { t: "Reply", ref: msg.ref, reply: out.reply },
          "gen_server.ml:reply",
        );
      } else if (msg.t === "Cast") {
        state = cb.handleCast
          ? cb.handleCast(msg.req as Req, state)
          : state;
      }
    }
  };
}

/**
 * OTP 24+ gen:call — monitor with `{alias, demonitor}`, send, receive
 * Reply | DOWN. Reply is addressed to the alias. Timeout demonitors
 * (alias dies); a Reply already in the mailbox is still taken; a
 * later send to the alias drops.
 */
export function* call(
  to: Pid,
  req: unknown,
  loc = "gen_server.ml:call",
  timeout = 4000,
): Generator<import("./types.ts").Effect, unknown, unknown> {
  const me = (yield fx.self(loc)) as Pid;
  const ref = (yield fx.monitor(to, loc, "demonitor")) as Ref;
  yield fx.send(to, { t: "Call", from: me, ref, req }, loc);
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
    if (leftover.t === "Reply") return leftover.reply;
    throw new Error("timeout");
  }
  yield fx.demonitor(ref, loc, true);
  if (m.t === "Reply") return m.reply;
  if (m.t === "DOWN") throw new Error(m.reason);
  throw new Error("timeout");
}

export function echo(): Callback<null, unknown, unknown> {
  return {
    init: () => null,
    handleCall: (req, _from, state) => ({
      reply: req === "ping" ? "pong" : req,
      state,
    }),
  };
}
