(* semantics.ml — OTP behaviour as a test suite, not a feature list.
 *
 * The kitchen is a visualisation of the same runtime.  These cases are
 * the spec: Erlang semantics on top, OCaml 5 effects in the middle,
 * Eio fibers underneath.  Eio is not allowed to leak into the API.
 *
 *     Erlang  spawn / send / receive / link / monitor / exit / supervisor
 *        │
 *     Effects perform Receive → handler scans mailbox, continues k
 *        │     (receive / send / wait belong here)
 *     Runtime Pid · mailbox · link · monitor · lifecycle · supervision
 *        │
 *     Eio     Fiber.fork / Switch / Clock
 *
 * Switch ≠ link graph.  See actor.ml.  Multi-domain Eio is v2.
 *)

open Actor

(* The public API.  A process is a pid, a mailbox, and a function.
   spawn returns the pid; send is fire-and-forget; receive is a
   pattern, not a FIFO pop. *)

type pid
type 'msg mailbox
type process = {
  pid     : pid;
  mailbox : 'msg mailbox;
  run     : unit -> unit;
}

(*
   let chef =
     spawn @@ fun () ->
       let msg = receive Grill in
       cook msg
*)

(* Selective receive is the case that proves the handler owns the
   mailbox, not the fiber.  First match is taken; the rest stay, in
   order, including later matches of the same pattern.

     mailbox  [fry; grill; pass; grill; fry]
     receive grill
     mailbox  [fry; pass; grill; fry]
*)

(* Mailbox dies with the pid.  A restarted cook is Pid 18, empty
   mailbox.  whereis "grill" → 18.  The in-flight ticket to 17 drops.
   Never silently forward to the new worker. *)

(* link + exit.  The mailbox carries both business terms and system
   messages.  perform Receive is one scan over both.

     A ──link── B     trap_exit = true on A
     B exits
     mailbox A  [grill; EXIT killed; fry]
     receive fry
     mailbox A  [grill; EXIT killed]

   normal: linked partner does not die.
   kill:   untrappable; dest dies as killed.
   unlink: bidirectional; cascade stops.
*)

(* monitor is unidirectional.  B dies → A gets DOWN, A stays alive.
   That is the whole difference from link, and the reason
   gen_server:call can fail instead of hanging:

     Ref = monitor B
     send B (Call me Ref ping)
     receive
       | Reply Ref pong -> demonitor Ref ~flush:true; pong
       | Down  Ref killed -> demonitor Ref ~flush:true; fail

   OTP 24 (EEP-53): gen:reply sends to the alias, not the Pid.
   Timeout deactivates the alias; a late Reply drops like send-to-dead-Pid.
   Receive marker: scan only messages that arrived after the Ref was created.
*)

(* gen_server is a functor, not a -behaviour attribute.  Callback
   state is abstract; missing handle_call is a type error.  Cast is
   send with no monitor and no reply. *)

(* Supervision.  rest_for_one is the one people skip:

     start order  A, B, C
     B crashes
     one_for_one   restart B
     rest_for_one  kill C, restart B then C; A lives
     one_for_all   kill A and C, restart A, B, C

   Intensity: more than maxR deaths in maxT, the supervisor itself
   exits, and the next level takes over.  Let it crash, at every level.

   Child restart types:
     permanent   always
     transient   only abnormal
     temporary   never   (simple_one_for_one children)
*)
