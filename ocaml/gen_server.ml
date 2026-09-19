(* gen_server.ml — OTP gen_server as a functor, not a -behaviour attribute.
   Call is monitor + send + selective receive of Reply | DOWN.  Without
   unidirectional monitor, call cannot be distinguished from a stuck server.

   Erlang's `-behaviour(gen_server)` is an attribute the compiler warns
   about.  A functor makes the callback a real module type: `state` is
   abstract, `handle_call` / `handle_cast` are exhaustive at the functor
   application, and a missing callback is a type error rather than a
   runtime `undef`.  That is the Caramel argument — the module system
   plus exhaustiveness — applied to the behaviour that needs it most. *)

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
            send from (Reply (r, reply));
            loop state
        | Cast req -> loop (C.handle_cast req state)
        | _ -> loop state
      in
      loop (C.init ())

  (* gen_server:call/2 — the reason monitor exists. *)
  let call pid req =
    let me = self () in
    let r = monitor pid in
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
        failwith "timeout"
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
