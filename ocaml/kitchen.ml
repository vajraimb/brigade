(* kitchen.ml — the scenario.
   A late-night brigade: each cook is a process, each ticket is a message,
   the sous-chef is a one_for_one supervisor.  Let it crash. *)

open Actor
open Supervisor

type station = Grill | Fry | Pass

type menu = {
  name : string;
  station : station;
  cook_for : float;
  poison : bool;
}

type msg +=
  | Ticket of { station : station; item : string; order : pid; poison : bool }
  | Plated of { item : string; order : pid }
  | Ready of { item : string; order : pid }

let station_name = function Grill -> "grill" | Fry -> "fry" | Pass -> "pass"

(* Selective receive: a grill cook will only take Grill tickets
   (and Crash).  A fry ticket sitting in this mailbox stays there —
   exactly Erlang's receive-with-pattern. *)

let cook station () =
  register (station_name station);
  let rec loop () =
    let msg =
      receive (function
        | Ticket t when t.station = station -> true
        | Crash -> true
        | _ -> false) ()
    in
    match msg with
    | Crash -> failwith "pan on fire"
    | Ticket t when t.poison -> failwith "poison ticket"
    | Ticket t ->
        sleep t.cook_for;                                   (* cook *)
        (match whereis "pass" with
         | Some pass -> send pass (Plated { item = t.item; order = t.order })
         | None -> ());
        loop ()
    | _ -> loop ()
  in
  loop ()

let pass () =
  register "pass";
  let rec loop () =
    match receive (function Plated _ | Crash -> true | _ -> false) () with
    | Crash -> failwith "pass down"
    | Plated p ->
        sleep 0.28;
        send p.order (Ready { item = p.item; order = p.order });
        loop ()
    | _ -> loop ()
  in
  loop ()

(* The order is a temporary client.  If the cook dies mid-ticket the
   mailbox dies with it — so the order times out and retries against
   whoever currently owns the registered name.  Isolation: other
   stations keep cooking. *)

let order item () =
  let me = self () in
  let rec attempt n =
    if n > 3 then ()
    else
      match whereis (station_name item.station) with
      | None -> sleep 0.4; attempt n
      | Some cook_pid ->
          send cook_pid (Ticket {
            station = item.station; item = item.name;
            order = me; poison = item.poison;
          });
          match
            receive ~timeout:4.0
              (function Ready r when r.order = me -> true | _ -> false) ()
          with
          | Ready _ -> ()
          | _ -> sleep 0.3; attempt (n + 1)
  in
  attempt 1

let line_sup () =
  supervise ~name:"line_sup" ~strategy:One_for_one
    [ child "grill" (cook Grill)
    ; child "fry"   (cook Fry)
    ; child "pass"  pass
    ]

let service_sup () = simple_one_for_one ~name:"service_sup" ()

let brigade () =
  supervise ~name:"brigade_sup" ~strategy:One_for_one
    [ child "line_sup" line_sup
    ; child "service_sup" service_sup
    ]

let () = run brigade
