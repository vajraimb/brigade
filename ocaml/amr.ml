(* amr.ml — Agent Messaging Runtime on BRIGADE.
   Room / participant / envelope / processing-ack / alias drop.
   Not a chat backend: a supervised messaging kernel for agents, tools,
   and humans.  Kitchen stays a visualization.  This file is the overlay.

   room_server is a process, not a gen_server functor: it must spawn
   deadline timers and receive DOWN.  handle_call is pure; a room is not.

   send_and_wait_ack is OTP 24 gen:call pointed at the room:
   monitor ~alias:true, send envelope with reply_ref, receive Reply|DOWN.
   Timeout deactivates the alias.  A late ack cannot move a terminal
   delivery, and a Reply to a dead alias is dropped like a dead Pid. *)

open Actor

type presence = Alive | Busy | Restarting | Degraded | Offline
type kind = Agent | Tool | Human
type delivery_state =
  | Accepted | Routed | Delivered | Acked
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
  payload : payload;
}

type msg +=
  | Send of envelope
  | Deliver of envelope
  | Ack of string * string
  | Cancel of string
  | Deadline of string
  | Hello of string
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
  | Ack (id, _from) ->
      (* if delivery already Timed_out|Cancelled|Failed, drop *)
      ignore id;
      room_loop ()
  | Cancel id -> ignore id; room_loop ()
  | Deadline id -> ignore id; room_loop ()
  | Hello id ->
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

let rec participant_loop spec =
  register spec;
  (match whereis "room" with
   | exception _ -> ()
   | pid -> send pid (Hello spec));
  match
    receive
      (function Deliver _ | Leave _ | Crash -> true | _ -> false)
      ()
  with
  | Crash -> failwith "participant abort"
  | Leave _ -> ()
  | Deliver env ->
      send (whereis "room") (Ack (env.delivery_id, spec));
      participant_loop spec
  | _ -> participant_loop spec

let register_log () = register "event_log"
let rec log_loop () =
  match receive (function Crash -> true | _ -> false) () with
  | Crash -> failwith "event_log abort"
  | _ -> log_loop ()

let register_psup () = register "participant_sup"
let trap_psup () = trap_exit true

(* participant_sup: agent/tool transient, human temporary.
   stop_p marks temporary then exit_pid shutdown so a hanging worker leaves. *)
let rec psup_loop () =
  match
    receive
      (function Spawn_p _ | Stop_p _ | Exit _ | Crash -> true | _ -> false)
      ()
  with
  | Crash -> failwith "participant_sup abort"
  | Spawn_p (id, _) ->
      ignore (spawn ~name:id ~link:true (fun () -> participant_loop id));
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
