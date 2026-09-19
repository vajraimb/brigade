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
| `gen_server:call` | alias + Reply; crash → DOWN; timeout → late Reply drops |
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

`monitor` is the other half of the graph: one direction, never a cascade, always a mailbox message.

## Alias is not a Pid

OTP 24 (EEP-53) changed `gen:call`. The textbook shape `monitor + send + receive Reply|DOWN` is OTP 23. From OTP 24, `gen:call` does `monitor(Pid, [{alias, demonitor}])` and `gen:reply` is `Alias ! {Tag, Reply}` — not `Pid ! {Tag, Reply}`.

An alias is a Ref that also names a process, until it is deactivated. Send to a dead alias drops, the same way send to a dead Pid drops. `demonitor` deactivates the alias. Timeout therefore cannot leave a stray Reply in the client mailbox: the Reply is addressed to an address that no longer exists.

That is the same stale-Pid rule, with a new trigger: "deactivate when the call ends". Without it, a byte-for-byte diff against OTP 29.1 is a promise sitting on a fault line.

The receive-marker is the other half of the same structure. BEAM sees `Ref = monitor(...)` followed by `receive` whose every clause matches that Ref, and only scans messages that arrived after the Ref was created. Deep-mailbox `call` is O(1) on OTP, O(n) if you scan from the head. The marker is `createdSeq` on the monitor; it is not a separate feature.

`gen_server:call` is: alias-monitor + send + selective receive of `Reply | DOWN`. On timeout, demonitor (alias dies), then one `after 0` scan for a Reply that already entered the queue. Anything later drops.

## AMR

BRIGADE AMR is an OTP-style supervised messaging runtime for agents, tools, and humans. The kitchen stays a visualization; the 战情 tab is the same runtime looking at a room.

```
room_root_sup
├── room_server
├── participant_sup
│   ├── participant(agent:planner)     transient
│   ├── participant(agent:researcher)  transient
│   ├── participant(tool:browser)      transient
│   └── participant(human:reviewer)    temporary
└── event_log_worker                   permanent
```

A message is an envelope plus a delivery state machine: `Accepted → Routed → Delivered → Acked`, or `Timed_out` / `Cancelled` / `Failed`. Delivered is mailbox arrival; Acked is processing finished.

`send_and_wait_ack` is `gen_server:call` pointed at the room: monitor `{alias, demonitor}`, send, receive Reply | DOWN. Once a delivery is terminal, a late ack is dropped — at the room, and at the caller's alias. That is the same stale-Pid rule.

The 语义 tab has ten AMR cases, not in `OTP_IDS`. The kernel of the actor runtime does not change.

## Messages

`type msg = ..` is an open variant. OTP messages are open: user terms, `EXIT`, `DOWN`, `Call`, `Reply`, `Cast`, `Timeout`. A closed sum would have to know the application. Kitchen tickets (`Ticket` / `Plated` / `Ready`) are one overlay; they share the mailbox with system messages. One `perform Receive` scans both.

`Call` / `Reply` / `Cast` are not a second channel. They are terms with a `Ref`, so selective receive can pick the matching reply out of a busy mailbox the same way it picks `grill` out of `[fry, grill, pass]`.

## gen_server as a functor

Erlang `-behaviour(gen_server)` is an attribute. The compiler warns if a callback is missing; it does not know the state type. [`ocaml/gen_server.ml`](ocaml/gen_server.ml) is `Make (Callback)`: `state` is abstract, `handle_call` / `handle_cast` are exhaustive at the functor application, a missing callback is a type error. The TypeScript side is the same idea as a first-class callback module.

## Conformance

The kernel is `OTP_IDS.length` cases in [`src/lib/actor/semantics.ts`](src/lib/actor/semantics.ts). `npm run conform` dumps them as `id<TAB>got<TAB>path` TSV with a `# oracle:` header. Stderr is three-state:

```
brigade-self     22/22 PASS
otp-reference    SKIP (no escript)
differential     SKIP
```

Missing Erlang is SKIP for the last two, not a silent pass. Written against OTP 29.1 (2026-09). If `escript` is on PATH, `differential` is a byte-identical `got` column.

```sh
npm run conform
escript erlang/conformance.erl
```

## Non-goals (v2)

- **Multi-domain Eio.** Eio does not reuse a fiber across domains. One scheduler switch, one domain. Cross-domain processes, work-stealing, and `Eio.Domain_manager` stay out until the single-domain contract is boring.
- **Preemptive `kill`.** Eio cancellation is cooperative: a compute-only fiber does not notice `Switch` cancel until the next suspension point. BEAM preempts at a reduction budget (~4000). `exit(Pid, kill)` in this runtime is a flag the scheduler honors at the next effect, not a VM interrupt. That is a runtime property the library layer cannot fake.
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
