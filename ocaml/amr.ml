(* amr.ml — Agent Messaging Runtime on BRIGADE.
   Overlay on Pid / mailbox / link / monitor / alias / supervision.
   Kitchen stays a visualization.  This file is the overlay.

   room_server is a process, not a gen_server functor: it must spawn
   deadline timers and receive DOWN.  handle_call is pure; a room is not.

   Two independent gates.  Neither substitutes for the other:
     1. Room delivery gate — a terminal delivery never moves again.
        A late or stale Ack is recorded as drop, not applied.
     2. Caller alias gate — send_and_wait_ack deactivates the alias on
        timeout/cancel.  A later Reply is dropped like a dead Pid.
        The room does not sweep the caller mailbox.

   Invariants:
     1. A delivery reaches exactly one terminal state.
     2. Delivered = mailbox arrival; Acked = callback-confirmed completion.
     3. An Ack is valid only from the recipient's current generation.
     4. Terminal deliveries never transition again.
     5. Timeout/cancel deactivates the waiting alias before exposing completion.
     6. A participant DOWN fails every pending delivery addressed to that Pid.
     7. Room events describe runtime facts; they do not replace delivery state. *)

open Actor

type presence = Alive | Busy | Restarting | Degraded | Offline
type kind = Agent | Tool | Human
type delivery_state =
  | Accepted | Routed | Delivered | Acked | Rejected
  | Timed_out | Cancelled | Failed of string

type payload =
  | Chat of string
  | Command of string
  | System of string * string option

type envelope = {
  msg_id : string;
  delivery_id : string;
  room_id : string;
  from_ : string;
  to_ : string option;
  ack_required : bool;
  deadline_ms : float option;
  reply_ref : ref option;
  generation : int;
  payload : payload;
}

type ack = {
  delivery_id : string;
  participant : string;
  generation : int;
  outcome : [`Ok | `Rejected of string];
}

type msg +=
  | Send of envelope
  | Deliver of envelope
  | Ack of ack
  | Cancel of string
  | Deadline of string
  | Hello of string * int
  | Join of string * kind
  | Leave of string
  | Presence of string * presence
  | Spawn_p of string * kind
  | Stop_p of string

let register_room () = register "room"
let trap_room () = trap_exit true

let rec room_loop () =
  match
    receive
      (function
        | Send _ | Ack _ | Cancel _ | Deadline _ | Hello _
        | Join _ | Leave _ | Presence _ | Down _ | Exit _ | Crash -> true
        | _ -> false)
      ()
  with
  | Crash -> failwith "room abort"
  | Send env ->
      (* accepted → routed → delivered; timer if ack_required *)
      ignore env;
      room_loop ()
  | Ack a ->
      (* if delivery already terminal, drop.
         if generation <> delivery.generation, drop stale. *)
      ignore a;
      room_loop ()
  | Cancel id -> ignore id; room_loop ()
  | Deadline id -> ignore id; room_loop ()
  | Hello (id, _gen) ->
      ignore (monitor (whereis id));
      room_loop ()
  | Down _ | Exit _ | Join _ | Leave _ | Presence _ -> room_loop ()
  | _ -> room_loop ()

let send_and_wait_ack env timeout =
  let room = whereis "room" in
  let r = monitor ~alias:true room in
  send room (Send { env with reply_ref = Some r });
  match
    receive ~timeout
      (function
        | Reply (x, _) when x = r -> true
        | Down (x, _, _) when x = r -> true
        | _ -> false)
      ()
  with
  | Reply (_, _) ->
      demonitor r ~flush:true;
      `Acked
  | Down _ ->
      demonitor r ~flush:true;
      `Down
  | Timeout ->
      demonitor r ~flush:true;
      (match
         receive ~timeout:0.
           (function Reply (x, _) when x = r -> true | _ -> false)
           ()
       with
       | Reply (_, _) -> `Acked
       | _ -> `Timeout)
  | _ ->
      demonitor r ~flush:true;
      `Timeout

let rec participant_loop spec generation =
  register spec;
  (match whereis "room" with
   | exception _ -> ()
   | pid -> send pid (Hello (spec, generation)));
  match
    receive
      (function Deliver _ | Leave _ | Crash -> true | _ -> false)
      ()
  with
  | Crash -> failwith "participant abort"
  | Leave _ -> ()
  | Deliver env ->
      send (whereis "room")
        (Ack { delivery_id = env.delivery_id; participant = spec;
               generation; outcome = `Ok });
      participant_loop spec generation
  | _ -> participant_loop spec generation

let register_log () = register "event_log"
let rec log_loop () =
  match receive (function Crash -> true | _ -> false) () with
  | Crash -> failwith "event_log abort"
  | _ -> log_loop ()

let register_psup () = register "participant_sup"
let trap_psup () = trap_exit true

(* participant_sup: agent/tool transient, human temporary.
   stop_p marks temporary then exit_pid shutdown so a hanging worker leaves.
   Each spawn bumps generation.  Old generation cannot ack a new world. *)
let rec psup_loop () =
  match
    receive
      (function Spawn_p _ | Stop_p _ | Exit _ | Crash -> true | _ -> false)
      ()
  with
  | Crash -> failwith "participant_sup abort"
  | Spawn_p (id, _) ->
      ignore (spawn ~name:id ~link:true (fun () -> participant_loop id 1));
      psup_loop ()
  | Stop_p id ->
      (match whereis id with
       | exception _ -> ()
       | pid -> exit_pid pid "shutdown");
      psup_loop ()
  | Exit (_pid, reason) ->
      (* transient + abnormal → spawn again; temporary / normal → drop *)
      ignore reason;
      psup_loop ()
  | _ -> psup_loop ()

let timer delivery_id ms =
  sleep ms;
  send (whereis "room") (Deadline delivery_id)
