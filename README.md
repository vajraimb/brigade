# BRIGADE

OTP-style actor runtime: OCaml 5 effects, Eio underneath, a kitchen so you can see it.

```
OTP semantics     spawn send receive link exit supervisor
        │
Effects           receive / send / wait
                  perform → mailbox scan → continue k
        │
Runtime           Pid · mailbox · link · lifecycle · supervision
        │
Eio               Fiber.fork · Switch · Clock
```

Eio does not leak into the API. `Pid ≠ worker function`. A cook that dies takes its mailbox with it; `whereis` returns the new Pid; send to the old one drops.

The **语义** tab is the contract. Selective receive and `link`/`exit` are the two cases that prove this is not `await next_message()` and not `try worker() catch worker()`. Combination cases stack them: restart + skip EXIT + stale Pid, rest_for_one + dying mailboxes, intensity + parent tree.

| Primitive | Expected |
|---|---|
| selective receive | `[fry, grill, pass, grill, fry]` → receive grill → `[fry, pass, grill, fry]` |
| system message | `[grill, EXIT killed, fry]` → receive fry → `[grill, EXIT killed]` |
| `normal` | linked partner does not die |
| `kill` | untrappable; dest exits as `killed` |
| `unlink` | cascade stops |
| stale Pid | send to 17 drops; whereis is 18 |
| `one_for_one` / `rest_for_one` / `one_for_all` | policy, not try/catch |
| intensity · permanent / transient / temporary | OTP child restart |

OCaml source of record: [`ocaml/actor.ml`](ocaml/actor.ml), [`ocaml/supervisor.ml`](ocaml/supervisor.ml), [`ocaml/semantics.ml`](ocaml/semantics.ml).

## Run

```sh
npm install
npm run dev
npm test
```

## License

MIT
