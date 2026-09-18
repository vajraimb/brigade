(* supervisor.ml — OTP-style supervision, itself just a process.
   The supervisor is not a special runtime object: it spawn/link/receive
   like everyone else, traps exits, and restarts according to strategy. *)

open Actor

type strategy = One_for_one | One_for_all | Rest_for_one | Simple_one_for_one
type restart = Permanent | Transient | Temporary

type child_spec = {
  id : string;
  start : unit -> unit;
  restart : restart;
}

let child ?(restart = Permanent) id start = { id; start; restart }

type intensity = { max : int; period : float }

let rec take_recent now period = function
  | t :: rest when now -. t <= period -> t :: take_recent now period rest
  | _ -> []

(* one_for_one: only the dead child is restarted.
   one_for_all: kill the rest, restart everyone.
   Intensity: more than [max] restarts in [period] seconds
   and the supervisor itself dies — the next level takes over. *)

let supervise ?(strategy = One_for_one)
    ?(intensity = { max = 6; period = 12.0 })
    ?(name = "sup") specs =
  register name;
  trap_exit true;
  let spawn_one spec = spawn ~name:spec.id ~link:true spec.start in
  let children =
    specs |> List.map (fun spec -> spec, spawn_one spec, ([] : float list))
  in
  let state = ref children in
  let rec loop () =
    match receive (function Exit _ | Crash -> true | _ -> false) () with
    | Crash -> failwith "supervisor abort"
    | Exit (pid, reason) ->
        let rec restart acc = function
          | [] -> List.rev acc
          | (spec, child_pid, hist) :: rest when child_pid = pid ->
              let skip =
                spec.restart = Temporary
                || (spec.restart = Transient && reason = "normal")
              in
              if skip then restart acc rest
              else
                let t = now () in
                let hist = t :: take_recent t intensity.period hist in
                if List.length hist > intensity.max then
                  failwith "intensity exceeded"
                else begin
                  (match strategy with
                   | One_for_all ->
                       List.iter (fun (_, p, _) -> send p Crash) acc;
                       List.iter (fun (_, p, _) -> send p Crash) rest
                   | _ -> ());
                  let child_pid = spawn_one spec in
                  restart ((spec, child_pid, hist) :: acc) rest
                end
          | row :: rest -> restart (row :: acc) rest
        in
        state := restart [] !state;
        loop ()
    | _ -> loop ()
  in
  loop ()

(* simple_one_for_one: one template, Start_child clones it.
   Children are Temporary — they are not restarted.  Used for
   per-request processes (here: each ticket / order). *)

type msg += Start_child of (unit -> unit) * string

let simple_one_for_one ?(name = "sofs") () =
  register name;
  trap_exit true;
  let rec loop () =
    match receive (function Start_child _ | Exit _ | Crash -> true | _ -> false) () with
    | Crash -> failwith "service abort"
    | Start_child (fn, id) ->
        ignore (spawn ~name:id ~link:true fn);
        loop ()
    | Exit (_, _) ->
        (* temporary: forget the child *)
        loop ()
    | _ -> loop ()
  in
  loop ()
