# BRIGADE

Late-night kitchen as an OTP supervision tree.

Erlang’s four primitives — **spawn / send / receive / supervisor** — written as OCaml 5 algebraic effects, scheduled like Eio fibers, and run as a live actor topology in the browser.

| Primitive | In the kitchen |
|---|---|
| `spawn` | Hire a cook, or open an order process. Returns a Pid. |
| `send` | Drop a ticket in a mailbox. Do not wait. |
| `receive` | Selective take: grill only matches grill tickets. The rest stay. |
| `supervisor` | The sous-chef traps `EXIT` and restarts one-for-one. Let it crash. |

Tree:

```
brigade_sup          one_for_one
├─ line_sup          one_for_one
│  ├─ grill
│  ├─ fry
│  └─ pass
└─ service_sup       simple_one_for_one
   └─ order-*        temporary
```

A cook that dies loses its mailbox. The order times out, `whereis` the new cook, and resends. Other stations keep working.

OCaml source of record: [`ocaml/actor.ml`](ocaml/actor.ml), [`ocaml/supervisor.ml`](ocaml/supervisor.ml), [`ocaml/kitchen.ml`](ocaml/kitchen.ml). The browser runtime in `src/lib/actor` is a faithful handler of the same effects.

## Run

```sh
npm install
npm run dev
```

## What to try

- Watch tickets fly grill → pass → order
- Select a cook, crash it — only that Pid dies; the supervisor respawns
- Send a poison ticket — bad data kills the cook, the client retries
- Kill `line_sup` — the whole line falls and comes back
- The source panel follows the current `perform`

## License

MIT
