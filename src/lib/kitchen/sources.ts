import actorMl from "../../../ocaml/actor.ml?raw";
import supervisorMl from "../../../ocaml/supervisor.ml?raw";
import kitchenMl from "../../../ocaml/kitchen.ml?raw";
import semanticsMl from "../../../ocaml/semantics.ml?raw";
import genServerMl from "../../../ocaml/gen_server.ml?raw";

export const SOURCES: Record<string, string> = {
  "actor.ml": actorMl,
  "supervisor.ml": supervisorMl,
  "kitchen.ml": kitchenMl,
  "semantics.ml": semanticsMl,
  "gen_server.ml": genServerMl,
};

export const FILES = [
  "kitchen.ml",
  "supervisor.ml",
  "actor.ml",
  "gen_server.ml",
  "semantics.ml",
] as const;
export type SourceFile = (typeof FILES)[number];

/** loc tag → 1-based line in the corresponding file. Filled from the raw sources. */
export const LOC_LINE: Record<string, { file: SourceFile; line: number }> = {};

function mark(file: SourceFile, needle: string, loc: string) {
  const src = SOURCES[file];
  if (!src) return;
  const lines = src.split("\n");
  const idx = lines.findIndex((l) => l.includes(needle));
  if (idx >= 0) LOC_LINE[loc] = { file, line: idx + 1 };
}

mark("kitchen.ml", "register (station_name station)", "kitchen.ml:cook.register");
mark("kitchen.ml", "Ticket t when t.station = station", "kitchen.ml:cook.receive");
mark("kitchen.ml", "sleep t.cook_for", "kitchen.ml:cook.sleep");
mark("kitchen.ml", 'send pass (Plated', "kitchen.ml:cook.send");
mark("kitchen.ml", 'register "pass"', "kitchen.ml:pass.register");
mark("kitchen.ml", "Plated _ | Crash", "kitchen.ml:pass.receive");
mark("kitchen.ml", "sleep 0.28", "kitchen.ml:pass.sleep");
mark("kitchen.ml", "send p.order (Ready", "kitchen.ml:pass.send");
mark("kitchen.ml", "let me = self ()", "kitchen.ml:order.self");
mark("kitchen.ml", "whereis (station_name item.station)", "kitchen.ml:order.whereis");
mark("kitchen.ml", "send cook_pid (Ticket", "kitchen.ml:order.send");
mark("kitchen.ml", "receive ~timeout:4.0", "kitchen.ml:order.receive");
mark("kitchen.ml", "sleep 0.4; attempt n", "kitchen.ml:order.wait");
mark("kitchen.ml", "sleep 0.3; attempt (n + 1)", "kitchen.ml:order.retry");

mark("supervisor.ml", "register name;", "supervisor.ml:register");
mark("supervisor.ml", "trap_exit true;", "supervisor.ml:trap_exit");
mark("supervisor.ml", "let spawn_one spec", "supervisor.ml:spawn");
mark("supervisor.ml", "Exit _ | Crash", "supervisor.ml:receive");
mark("supervisor.ml", "let t = now ()", "supervisor.ml:intensity");
mark("supervisor.ml", "let child_pid = spawn_one spec", "supervisor.ml:restart");
mark("supervisor.ml", 'exit_pid p "shutdown"', "supervisor.ml:shutdown");
mark("supervisor.ml", 'simple_one_for_one ?(name = "sofs")', "supervisor.ml:sofs.register");
mark("supervisor.ml", "trap_exit true;", "supervisor.ml:sofs.trap_exit");
mark("supervisor.ml", "Start_child _ | Exit _ | Crash", "supervisor.ml:sofs.receive");
mark("supervisor.ml", "ignore (spawn ~name:id", "supervisor.ml:sofs.spawn");

mark("actor.ml", "| Spawn     :", "actor.ml:spawn");
mark("actor.ml", "p.alive <- false", "actor.ml:die");
mark("actor.ml", 'retc = (fun () -> die p "normal")', "actor.ml:retc");
mark("actor.ml", "| Exit_me   :", "actor.ml:exit");
mark("actor.ml", "| Unlink    :", "actor.ml:unlink");
mark("actor.ml", "| Monitor   :", "actor.ml:monitor");
mark("actor.ml", "| Demonitor :", "actor.ml:demonitor");

mark("semantics.ml", "receive fry", "semantics.ml:run");

mark("gen_server.ml", "register name;", "gen_server.ml:register");
mark("gen_server.ml", "let rec loop state", "gen_server.ml:loop");
mark("gen_server.ml", "send from (Reply", "gen_server.ml:reply");
mark("gen_server.ml", "let call pid req", "gen_server.ml:call");
mark("gen_server.ml", "let r = monitor pid", "gen_server.ml:monitor");

export function fileForLoc(loc: string | null | undefined): SourceFile {
  if (!loc) return "kitchen.ml";
  const hit = LOC_LINE[loc];
  if (hit) return hit.file;
  if (loc.startsWith("semantics")) return "semantics.ml";
  if (loc.startsWith("gen_server")) return "gen_server.ml";
  if (loc.startsWith("supervisor")) return "supervisor.ml";
  if (loc.startsWith("actor")) return "actor.ml";
  return "kitchen.ml";
}

export function lineForLoc(loc: string | null | undefined): number | null {
  if (!loc) return null;
  return LOC_LINE[loc]?.line ?? null;
}

export function fileForProcess(name: string): SourceFile {
  if (name.endsWith("_sup")) return "supervisor.ml";
  if (name === "init") return "actor.ml";
  if (name === "echo" || name === "client") return "gen_server.ml";
  return "kitchen.ml";
}
