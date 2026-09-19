(* semantics.ml — OTP behaviour as a test suite, not a feature list.
 *
 * The kitchen is a visualisation of the same runtime.  These cases are
 * the spec: Erlang semantics on top, OCaml 5 effects in the middle,
 * Eio fibers underneath.  Eio is not allowed to leak into the API.
 *
 *     Erlang  spawn / send / receive / link / exit / supervisor
 *        │
 *     Effects perform Receive → handler scans mailbox, continues k
 *        │
 *     Eio     Fiber.fork / Switch / Clock
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
   mailbox.  whereis "grill" → 18.  The in-flight ticket to 17 drops. *)

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
