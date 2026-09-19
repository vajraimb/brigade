# BRIGADE

OTP-style actor runtime: OCaml 5 effects, Eio underneath, a kitchen so you can see it.

```
OTP semantics     spawn send receive link monitor exit supervisor gen_server
        │
Effects           receive / send / wait
                  perform → mailbox scan → continue k
        │
Runtime           Pid · mailbox · link · monitor · lifecycle · supervision
        │
Eio               Fiber.fork · Switch · Clock
```

Eio does not leak into the API. `Pid ≠ worker function`. A cook that dies takes its mailbox with it; `whereis` returns the new Pid; send to the old one drops.

The **语义** tab is the contract. Selective receive and `link`/`exit` prove this is not `await next_message()` and not `try worker() catch worker()`. `monitor` / `DOWN` is why `gen_server:call` can fail instead of hanging. Combination cases stack them: restart + skip EXIT + stale Pid, rest_for_one + dying mailboxes, intensity + parent tree.

| Primitive | Expected |
|---|---|
| selective receive | `[fry, grill, pass, grill, fry]` → receive grill → `[fry, pass, grill, fry]` |
| system message | `[grill, EXIT killed, fry]` → receive fry → `[grill, EXIT killed]` |
| `normal` | linked partner does not die |
| `kill` | untrappable; dest exits as `killed` |
| `unlink` | cascade stops |
| stale Pid | send to 17 drops; whereis is 18 |
| `monitor` | B dies → A gets `DOWN`, A lives |
| `monitor` dead Pid | immediate `DOWN noproc` |
| `demonitor flush` | takes the matching `DOWN` out of the mailbox |
| `gen_server:call` | monitor + Reply; server crash → `DOWN`, client lives |
| `one_for_one` / `rest_for_one` / `one_for_all` | policy, not try/catch |
| intensity · permanent / transient / temporary | OTP child restart |

OCaml source of record: [`ocaml/actor.ml`](ocaml/actor.ml), [`ocaml/supervisor.ml`](ocaml/supervisor.ml), [`ocaml/gen_server.ml`](ocaml/gen_server.ml), [`ocaml/semantics.ml`](ocaml/semantics.ml).

## Switch is not the link graph

Eio.Switch is a cancellation tree for fibers and resources. Erlang `link` is a bidirectional death-propagation graph on Pids, with `trap_exit` converting the signal into a mailbox message.

They answer different questions:

| | Eio Switch | OTP link |
|---|---|---|
| Identity | fiber / resource owner | Pid |
| `normal` return | cancels children | notifies, does not kill |
| `kill` | not a concept | untrappable; dest reason is `killed` |
| `trap_exit` | not a concept | `{'EXIT', Pid, Reason}` in the same mailbox |
| unlink | cannot reparent a live fiber | bidirectional, immediate |
| monitor | not a concept | unidirectional `DOWN` |

If link were Switch, `exit(normal)` would cancel the partner, `trap_exit` could not turn a signal into a message, and `unlink` would require reparenting a running fiber. Each process is a fiber forked on the scheduler switch; death of a linked partner is `die` / `propagate` in the runtime. The Switch outlives the process graph. That split is the architecture, not an implementation detail.

`monitor` is the other half of the graph: one direction, never a cascade, always a mailbox message. `gen_server:call` is monitor + send + selective receive of `Reply | DOWN`. Without it, a dead server is a client that waits forever.

## Messages

`type msg = ..` is an open variant. OTP messages are open: user terms, `EXIT`, `DOWN`, `Call`, `Reply`, `Cast`, `Timeout`. A closed sum would have to know the application. Kitchen tickets (`Ticket` / `Plated` / `Ready`) are one overlay; they share the mailbox with system messages. One `perform Receive` scans both.

`Call` / `Reply` / `Cast` are not a second channel. They are terms with a `Ref`, so selective receive can pick the matching reply out of a busy mailbox the same way it picks `grill` out of `[fry, grill, pass]`.

## gen_server as a functor

Erlang `-behaviour(gen_server)` is an attribute. The compiler warns if a callback is missing; it does not know the state type. [`ocaml/gen_server.ml`](ocaml/gen_server.ml) is `Make (Callback)`: `state` is abstract, `handle_call` / `handle_cast` are exhaustive at the functor application, a missing callback is a type error. The TypeScript side is the same idea as a first-class callback module.

## Conformance

The kernel is 20 cases (`OTP_IDS` in [`src/lib/actor/semantics.ts`](src/lib/actor/semantics.ts)). `npm run conform` dumps them as `id<TAB>got` TSV. If `escript` is on PATH, it runs [`erlang/conformance.erl`](erlang/conformance.erl) against real OTP and diffs byte-for-byte. Written against OTP 29.1 (2026-09). Missing Erlang is a skip, not a fail.

```sh
npm run conform
escript erlang/conformance.erl
```

## Non-goals (v2)

- **Multi-domain Eio.** Eio does not reuse a fiber across domains. One scheduler switch, one domain. Cross-domain processes, work-stealing, and `Eio.Domain_manager` stay out until the single-domain contract is boring.
- Distributed Erlang, `net_kernel`, node names.
- Full `proc_lib` / `sys` / application controller / release handling.
- Hot code swap, BEAM binary compatibility, ETS.
- Using Switch, Promise, or `try/catch` as a substitute for link, monitor, or supervision.

## Run

```sh
npm install
npm run dev
npm test
npm run conform
```

## License

MIT
