(* actor.ml — Erlang spawn / send / receive, as OCaml 5 effects,
   scheduled on Eio fibers.

   Effect layer:  receive / send / wait  (perform, scan, continue k)
   Runtime layer: Pid, mailbox, link, monitor, alias, lifecycle, supervision
   Eio:           Fiber.fork / Switch / Clock — scheduling only.

   Switch is not the link graph.  Eio.Switch cancels fibers and closes
   resources when a tree of forks unwinds.  Erlang link is a bidirectional
   death-propagation graph on Pids, with trap_exit converting the signal
   into a mailbox message.  Mapping link onto Switch would make `normal`
   kill the partner, make `kill` indistinguishable from cancel, and make
   unlink impossible.  Each process is a fiber forked on the scheduler
   switch; death of a linked partner is `die` / `propagate` in this file.

   Each process runs inside a deep handler.  perform Spawn/Send/Receive
   is the program; the handler is the runtime (mailboxes + fibers).
   Eio stays under the handler.  The API is pid / mailbox / process. *)

open Effect
open Effect.Deep

type pid = int
type ref = int

type msg = ..

type 'msg mailbox = {
  q : 'msg Queue.t;
  cond : Eio.Condition.t;
}

type process = {
  pid : pid;
  name : string;
  mailbox : msg mailbox;
  mutable alive : bool;
  mutable trap_exit : bool;
  links : (pid, unit) Hashtbl.t;
  monitors : (ref, pid) Hashtbl.t;
  watched_by : (ref, pid) Hashtbl.t;
}

type _ Effect.t +=
  | Spawn     : { name : string; fn : unit -> unit; link : bool } -> pid t
  | Send      : pid * msg -> unit t
  | Receive   : { pred : msg -> bool; timeout : float option } -> msg t
  | Self      : pid t
  | Sleep     : float -> unit t
  | Register  : string -> unit t
  | Whereis   : string -> pid option t
  | Link      : pid -> unit t
  | Unlink    : pid -> unit t
  | Trap_exit : bool -> unit t
  | Now       : float t
  | Exit_me   : string -> unit t
  | Signal    : pid * string -> unit t
  | Monitor   : pid * bool -> ref t
  | Demonitor : ref * bool -> unit t
  | Send_alias : ref * msg -> unit t

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
let unlink pid = perform (Unlink pid)
let trap_exit on = perform (Trap_exit on)
let now () = perform Now
let exit_reason reason = perform (Exit_me reason)
let exit_pid pid reason = perform (Signal (pid, reason))
let monitor ?(alias = false) pid = perform (Monitor (pid, alias))
let demonitor ?(flush = false) r = perform (Demonitor (r, flush))
let send_alias r msg = perform (Send_alias (r, msg))

type msg +=
  | Exit of pid * string
  | Down of ref * pid * string
  | Timeout
  | Crash

(* ── mailbox: selective receive, not FIFO pop ──────────────────── *)

module Mailbox = struct
  type 'a t = 'a mailbox

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

  (* Same scan as receive, discard the match.  demonitor ~flush uses this
     so a DOWN already in the mailbox is taken even if it is not at the
     head — OTP does `receive {'DOWN', Ref, ...} after 0`. *)
  let drop t pred = ignore (scan t.q pred [])

  let rec take t pred =
    match scan t.q pred [] with
    | Some m -> m
    | None ->
        Eio.Condition.await t.cond;
        take t pred
end

type proc = process

module Scheduler (Env : sig
  val sw : Eio.Switch.t
  val clock : float Eio.Time.clock_ty Eio.Std.r
end) =
struct
  let next_pid = ref 1
  let next_ref = ref 1
  let procs : (pid, proc) Hashtbl.t = Hashtbl.create 32
  let names : (string, pid) Hashtbl.t = Hashtbl.create 16
  let aliases : (ref, pid) Hashtbl.t = Hashtbl.create 32

  let alloc name =
    let pid = !next_pid in
    incr next_pid;
    let p =
      { pid; name; mailbox = Mailbox.create (); alive = true;
        trap_exit = false; links = Hashtbl.create 4;
        monitors = Hashtbl.create 4; watched_by = Hashtbl.create 4 }
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
              else if reason <> "normal" then die q reason
          | _ -> ())
        p.links;
      Hashtbl.iter (fun r watcher ->
          match Hashtbl.find_opt procs watcher with
          | Some q when q.alive ->
              Hashtbl.remove q.monitors r;
              Hashtbl.remove aliases r;
              deliver q.pid (Down (r, p.pid, reason))
          | _ -> Hashtbl.remove aliases r)
        p.watched_by;
      Hashtbl.clear p.watched_by;
      Hashtbl.iter (fun r target ->
          Hashtbl.remove aliases r;
          match Hashtbl.find_opt procs target with
          | Some q -> Hashtbl.remove q.watched_by r
          | None -> ())
        p.monitors;
      Hashtbl.clear p.monitors
    end

  let signal from dest reason =
    if reason = "kill" then die dest "killed"
    else if dest.trap_exit then deliver dest.pid (Exit (from.pid, reason))
    else if reason = "normal" && dest.pid <> from.pid then ()
    else die dest reason

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
          | Unlink pid ->
              Some (fun k ->
                  Hashtbl.remove p.links pid;
                  Option.iter (fun q -> Hashtbl.remove q.links p.pid)
                    (Hashtbl.find_opt procs pid);
                  continue k ())
          | Trap_exit on -> Some (fun k -> p.trap_exit <- on; continue k ())
          | Now -> Some (fun k -> continue k (Eio.Time.now Env.clock))
          | Exit_me reason ->
              Some (fun k -> die p reason; discontinue k (Failure reason))
          | Signal (pid, reason) ->
              Some (fun k ->
                  Option.iter (fun q -> if q.alive then signal p q reason)
                    (Hashtbl.find_opt procs pid);
                  continue k ())
          | Monitor (pid, alias) ->
              Some (fun k ->
                  let r = !next_ref in
                  incr next_ref;
                  (match Hashtbl.find_opt procs pid with
                   | Some q when q.alive ->
                       Hashtbl.replace p.monitors r pid;
                       Hashtbl.replace q.watched_by r p.pid;
                       if alias then Hashtbl.replace aliases r p.pid
                   | _ -> deliver p.pid (Down (r, pid, "noproc")));
                  continue k r)
          | Demonitor (r, flush) ->
              Some (fun k ->
                  (match Hashtbl.find_opt p.monitors r with
                   | Some pid ->
                       Hashtbl.remove p.monitors r;
                       Hashtbl.remove aliases r;
                       Option.iter (fun q -> Hashtbl.remove q.watched_by r)
                         (Hashtbl.find_opt procs pid)
                   | None -> Hashtbl.remove aliases r);
                  if flush then
                    Mailbox.drop p.mailbox (function
                        | Down (x, _, _) when x = r -> true
                        | _ -> false);
                  continue k ())
          | Send_alias (r, msg) ->
              Some (fun k ->
                  (match Hashtbl.find_opt aliases r with
                   | Some pid -> deliver pid msg
                   | None -> ());
                  continue k ())
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
