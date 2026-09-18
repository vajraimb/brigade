(* actor.ml — Erlang spawn / send / receive, as OCaml 5 effects,
   scheduled on Eio fibers.

   Each process runs inside a deep handler.  perform Spawn/Send/Receive
   is the program; the handler is the runtime (mailboxes + fibers). *)

open Effect
open Effect.Deep

type pid = int

type msg = ..

type _ Effect.t +=
  | Spawn    : { name : string; fn : unit -> unit; link : bool } -> pid t
  | Send     : pid * msg -> unit t
  | Receive  : { pred : msg -> bool; timeout : float option } -> msg t
  | Self     : pid t
  | Sleep    : float -> unit t
  | Register : string -> unit t
  | Whereis  : string -> pid option t
  | Link     : pid -> unit t
  | Trap_exit : bool -> unit t
  | Now      : float t

let spawn ?(name = "") ?(link = false) fn =
  perform (Spawn { name; fn; link })

let send pid msg = perform (Send (pid, msg))
let receive ?(pred = fun _ -> true) ?timeout () =
  perform (Receive { pred; timeout })
let self () = perform Self
let sleep dt = perform (Sleep dt)
let register name = perform (Register name)
let whereis name = perform (Whereis name)
let link pid = perform (Link pid)
let trap_exit on = perform (Trap_exit on)
let now () = perform Now

type msg +=
  | Exit of pid * string
  | Timeout
  | Crash

(* ── Eio scheduler ─────────────────────────────────────────────── *)

module Mailbox = struct
  type t = {
    q : msg Queue.t;
    cond : Eio.Condition.t;
  }

  let create () = { q = Queue.create (); cond = Eio.Condition.create () }

  let rec scan q pred acc =
    match Queue.take_opt q with
    | None ->
        List.iter (fun m -> Queue.add m q) (List.rev acc);
        None
    | Some m when pred m ->
        List.iter (fun x -> Queue.add x q) (List.rev acc);
        Some m
    | Some m -> scan q pred (m :: acc)

  let push t m =
    Queue.add m t.q;
    Eio.Condition.broadcast t.cond

  let rec take t pred =
    match scan t.q pred [] with
    | Some m -> m
    | None ->
        Eio.Condition.await t.cond;
        take t pred
end

type proc = {
  pid : pid;
  name : string;
  mailbox : Mailbox.t;
  mutable alive : bool;
  mutable trap_exit : bool;
  links : (pid, unit) Hashtbl.t;
}

module Scheduler (Env : sig
  val sw : Eio.Switch.t
  val clock : float Eio.Time.clock_ty Eio.Std.r
end) =
struct
  let next_pid = ref 1
  let procs : (pid, proc) Hashtbl.t = Hashtbl.create 32
  let names : (string, pid) Hashtbl.t = Hashtbl.create 16

  let alloc name =
    let pid = !next_pid in
    incr next_pid;
    let p =
      { pid; name; mailbox = Mailbox.create (); alive = true;
        trap_exit = false; links = Hashtbl.create 4 }
    in
    Hashtbl.add procs pid p;
    p

  let deliver pid msg =
    match Hashtbl.find_opt procs pid with
    | Some p when p.alive -> Mailbox.push p.mailbox msg
    | _ -> () (* send to a dead pid is a silent drop, like Erlang *)

  let rec die p reason =
    if not p.alive then ()
    else begin
      p.alive <- false;
      Hashtbl.filter_map_inplace
        (fun _ pid' -> if pid' = p.pid then None else Some pid') names;
      Hashtbl.iter (fun other _ ->
          match Hashtbl.find_opt procs other with
          | Some q when q.alive ->
              Hashtbl.remove q.links p.pid;
              if q.trap_exit then deliver q.pid (Exit (p.pid, reason))
              else die q reason
          | _ -> ())
        p.links
    end

  let rec handle (p : proc) (body : unit -> unit) : unit =
    match_with body ()
      { retc = (fun () -> die p "normal")
      ; exnc = (fun exn -> die p (Printexc.to_string exn))
      ; effc = (fun (type a) (eff : a t) ->
          match eff with
          | Spawn { name; fn; link } ->
              Some (fun (k : (a, _) continuation) ->
                  let child = alloc name in
                  if link then begin
                    Hashtbl.replace p.links child.pid ();
                    Hashtbl.replace child.links p.pid ()
                  end;
                  Eio.Fiber.fork ~sw:Env.sw (fun () -> handle child fn);
                  continue k child.pid)
          | Send (pid, msg) ->
              Some (fun k -> deliver pid msg; continue k ())
          | Receive { pred; timeout } ->
              Some (fun k ->
                  match timeout with
                  | None -> continue k (Mailbox.take p.mailbox pred)
                  | Some dt ->
                      let finished = ref false in
                      let result = ref Timeout in
                      Eio.Fiber.first
                        (fun () ->
                           let m = Mailbox.take p.mailbox pred in
                           if not !finished then (finished := true; result := m))
                        (fun () ->
                           Eio.Time.sleep Env.clock dt;
                           if not !finished then finished := true);
                      continue k !result)
          | Self -> Some (fun k -> continue k p.pid)
          | Sleep dt ->
              Some (fun k -> Eio.Time.sleep Env.clock dt; continue k ())
          | Register name ->
              Some (fun k -> Hashtbl.replace names name p.pid; continue k ())
          | Whereis name ->
              Some (fun k -> continue k (Hashtbl.find_opt names name))
          | Link pid ->
              Some (fun k ->
                  Hashtbl.replace p.links pid ();
                  Option.iter (fun q -> Hashtbl.replace q.links p.pid ())
                    (Hashtbl.find_opt procs pid);
                  continue k ())
          | Trap_exit on -> Some (fun k -> p.trap_exit <- on; continue k ())
          | Now -> Some (fun k -> continue k (Eio.Time.now Env.clock))
          | _ -> None)
      }

  let run root =
    let p = alloc "init" in
    handle p root
end

let run fn =
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  let module S = Scheduler (struct
    let sw = sw
    let clock = env#clock
  end) in
  S.run fn
