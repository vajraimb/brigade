# BRIGADE

Late-night kitchen as an OTP supervision tree — and a semantic test suite for the runtime underneath.

Erlang’s primitives — **spawn / send / receive / link / exit / supervisor** — written as OCaml 5 algebraic effects, scheduled like Eio fibers. Eio stays under the handler. The API is `pid` / `mailbox` / `process`.

```
Erlang semantics
  spawn  send  receive  link  exit  supervisor
        │
OCaml 5 Effects
  perform Receive  →  handler scans mailbox, continues k
        │
Eio
  Fiber.fork  ·  Switch  ·  Clock
```

The kitchen is the visualisation. The **语义** tab is the spec: each case is an OTP behaviour, run against the same runtime.

| Primitive | Expected |
|---|---|
| `spawn` | New pid, empty mailbox |
| `send` / `receive` | Async deliver; pattern take |
| selective receive | `[fry, grill, pass, grill, fry]` → receive grill → `[fry, pass, grill, fry]` |
| mailbox | Dies with the pid. Restart is Pid 18, not a fiber rerun |
| `whereis` | Follows the registered name, not the old pid |
| `link` / `trap_exit` | Untrapped cascade; trapped becomes `{'EXIT', Pid, Reason}` |
| `one_for_one` | Only the dead child restarts |
| `rest_for_one` | Kill everyone started after it, restart them |
| `one_for_all` | Kill the rest, restart everyone |
| intensity | Too many restarts, the supervisor itself dies |
| `temporary` / `transient` / `permanent` | Never / abnormal only / always |

Tree the kitchen still runs:

```
brigade_sup          one_for_one
├─ line_sup          one_for_one
│  ├─ grill
│  ├─ fry
│  └─ pass
└─ service_sup       simple_one_for_one
   └─ order-*        temporary
```

A cook that dies loses its mailbox. The order times out, `whereis` the new cook, and resends.

OCaml source of record: [`ocaml/actor.ml`](ocaml/actor.ml), [`ocaml/supervisor.ml`](ocaml/supervisor.ml), [`ocaml/semantics.ml`](ocaml/semantics.ml), [`ocaml/kitchen.ml`](ocaml/kitchen.ml).

## Run

```sh
npm install
npm run dev
npm test
```

## License

MIT
