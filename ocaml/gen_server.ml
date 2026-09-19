(* gen_server.ml — OTP gen_server as a functor, not a -behaviour attribute.
   OTP 24+ call is monitor ~alias:true + send + selective receive of
   Reply | DOWN.  gen:reply sends to the alias, not the Pid.  Timeout
   deactivates the alias; a late Reply is dropped the same way a send
   to a dead Pid is dropped. *)

open Actor

type msg +=
  | Call of pid * ref * msg
  | Reply of ref * msg
  | Cast of msg
  | Ping
  | Pong
  | Nudge

module type Callback = sig
  type state
  val init : unit -> state
  val handle_call : msg -> pid -> state -> msg * state
  val handle_cast : msg -> state -> state
end

module Make (C : Callback) = struct
  let start_link name =
    spawn ~name ~link:true @@ fun () ->
      register name;
      let rec loop state =
        match receive (function Call _ | Cast _ | Crash -> true | _ -> false) () with
        | Crash -> failwith "gen_server abort"
        | Call (from, r, req) ->
            let reply, state = C.handle_call req from state in
            send_alias r (Reply (r, reply));
            loop state
        | Cast req -> loop (C.handle_cast req state)
        | _ -> loop state
      in
      loop (C.init ())

  (* OTP 24+ gen:call — monitor with {alias, demonitor}. *)
  let call pid req =
    let me = self () in
    let r = monitor ~alias:true pid in
    send pid (Call (me, r, req));
    match
      receive ~timeout:4.0
        (function
          | Reply (x, _) when x = r -> true
          | Down (x, _, _) when x = r -> true
          | _ -> false)
        ()
    with
    | Reply (_, rep) ->
        demonitor r ~flush:true;
        rep
    | Down (_, _, reason) ->
        demonitor r ~flush:true;
        failwith reason
    | Timeout ->
        demonitor r ~flush:true;
        (match
           receive ~timeout:0.
             (function Reply (x, _) when x = r -> true | _ -> false)
             ()
         with
         | Reply (_, rep) -> rep
         | _ -> failwith "timeout")
    | _ ->
        demonitor r ~flush:true;
        failwith "timeout"

  let cast pid req = send pid (Cast req)
end

module Echo = Make (struct
  type state = unit
  let init () = ()
  let handle_call req _from state =
    match req with
    | Ping -> (Pong, state)
    | other -> (other, state)
  let handle_cast _req state = state
end)
