import { useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Flame,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SourceView } from "@/components/source-view";
import { AmrSim, type AmrSnap } from "@/lib/amr/sim";
import type { Delivery, Kind, ParticipantRow } from "@/lib/amr/types";
import { fileForProcess, type SourceFile } from "@/lib/kitchen/sources";
import { labelOf } from "@/lib/actor/runtime";
import type { Pid, ProcSnap, TraceEvent, TraceOp } from "@/lib/actor/types";
import { cn } from "@/lib/utils";

type Tab = "tree" | "mailbox" | "source" | "log";
const SPEEDS = [0.5, 1, 2] as const;
const CHAIN: [string, string][] = [
  ["planner", "researcher"],
  ["researcher", "browser"],
  ["planner", "reviewer"],
  ["researcher", "planner"],
];

let held: AmrSim | null = null;
function takeSim(reset = false) {
  if (reset || held == null) held = new AmrSim();
  return held;
}

export function AmrView() {
  const simRef = useRef<AmrSim>(takeSim());
  const pausedRef = useRef(false);
  const speedRef = useRef(1);
  const autoRef = useRef(true);
  const selectedRef = useRef<Pid | null>(null);

  const [snap, setSnap] = useState<AmrSnap>(() => simRef.current!.snapshot());
  const [selected, setSelected] = useState<Pid | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [tab, setTab] = useState<Tab>("tree");
  const [file, setFile] = useState<SourceFile>("amr.ml");
  const [auto, setAuto] = useState(true);

  selectedRef.current = selected;
  pausedRef.current = paused;
  speedRef.current = speed;
  autoRef.current = auto;

  useEffect(() => {
    const sim = simRef.current!;
    let last = performance.now();
    let ui = 0;
    let trickle = 0;
    let hop = 0;
    let raf = 0;
    const loop = (t: number) => {
      const raw = Math.min(100, t - last);
      last = t;
      if (!pausedRef.current) {
        sim.tick(raw * speedRef.current);
        trickle += raw * speedRef.current;
        if (autoRef.current && trickle > 2400) {
          trickle = 0;
          const pair = CHAIN[hop++ % CHAIN.length]!;
          sim.send(pair[0], pair[1], "task");
        }
      }
      if (t - ui > 90) {
        ui = t;
        setSnap(sim.snapshot());
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const sim = simRef.current!;
    const id = window.setTimeout(() => {
      sim.send("planner", "researcher", "brief");
      sim.send("planner", "browser", "open");
    }, 500);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __amr?: unknown }).__amr = {
      snapshot: () => simRef.current?.snapshot(),
      send: () => simRef.current?.send("planner", "researcher", "task"),
    };
  }, []);

  const selectedProc = useMemo(() => {
    const p = snap.actor.processes.find((x) => x.pid === selected) ?? null;
    if (p?.alive) return p;
    if (!p) return null;
    return snap.actor.processes.find((x) => x.name === p.name && x.alive) ?? p;
  }, [snap, selected]);

  function pick(pid: Pid | null, name?: string) {
    setSelected(pid);
    if (name) setFile(fileForProcess(name));
    if (pid != null) setTab("mailbox");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 sm:px-6">
        <AmrControls
          paused={paused}
          speed={speed}
          auto={auto}
          canCrash={selectedProc?.alive === true}
          onPause={() => setPaused((p) => !p)}
          onSpeed={() =>
            setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]!)
          }
          onSend={() => simRef.current?.send("planner", "researcher", "task")}
          onTimeout={() => simRef.current?.timeoutDrill()}
          onCancel={() => simRef.current?.cancelLast()}
          onCrash={() => {
            if (selectedProc?.alive) simRef.current?.crash(selectedProc.pid);
            else simRef.current?.crashName("researcher");
          }}
          onAuto={() => setAuto((a) => !a)}
          onReset={() => {
            simRef.current = takeSim(true);
            setSnap(simRef.current.snapshot());
            setSelected(null);
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative flex min-h-[320px] flex-1 flex-col overflow-hidden lg:min-h-0">
          <p className="hidden px-4 pt-3 font-mono text-[11px] text-subtle sm:block sm:px-6">
            {snap.roomId} · 点参与者看邮箱 · 崩溃选中进程
          </p>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-6">
            <ParticipantGrid
              snap={snap}
              selected={selectedProc?.pid ?? null}
              onPick={pick}
            />
            <DeliveryList deliveries={snap.deliveries} />
          </div>
        </section>

        <aside className="flex min-h-[260px] w-full shrink-0 flex-col border-t border-border lg:w-[380px] lg:border-t-0 lg:border-l">
          <div className="flex border-b border-border">
            {(
              [
                ["tree", "监督树"],
                ["mailbox", "邮箱"],
                ["source", "源码"],
                ["log", "事件"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "h-11 flex-1 text-sm transition-colors duration-150",
                  tab === id ? "text-fg" : "text-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === "tree" && (
              <TreePanel
                snap={snap}
                selected={selectedProc?.pid ?? null}
                onSelect={(pid, name) => pick(pid, name)}
              />
            )}
            {tab === "mailbox" && <MailboxPanel proc={selectedProc} />}
            {tab === "source" && (
              <SourceView
                loc={selectedProc?.loc ?? snap.actor.lastLoc}
                file={file}
                onFile={setFile}
              />
            )}
            {tab === "log" && <LogPanel events={snap.events} actor={snap.actor.events} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function AmrControls(props: {
  paused: boolean;
  speed: number;
  auto: boolean;
  canCrash: boolean;
  onPause: () => void;
  onSpeed: () => void;
  onSend: () => void;
  onTimeout: () => void;
  onCancel: () => void;
  onCrash: () => void;
  onAuto: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button onClick={props.onPause} size="md" aria-label={props.paused ? "resume" : "pause"}>
        {props.paused ? <Play /> : <Pause />}
        {props.paused ? "继续" : "暂停"}
      </Button>
      <Button onClick={props.onSpeed} size="md" className="tabular-nums">
        {props.speed}x
      </Button>
      <Button onClick={props.onSend} size="md" variant="primary">
        <Plus />
        发信
      </Button>
      <Button onClick={props.onTimeout} size="md">
        <Timer />
        超时
      </Button>
      <Button onClick={props.onCancel} size="md">
        <Ban />
        取消
      </Button>
      <Button onClick={props.onCrash} size="md" variant="danger">
        <Flame />
        崩溃
      </Button>
      <Button onClick={props.onAuto} size="md" variant={props.auto ? "secondary" : "ghost"}>
        <Radio />
        {props.auto ? "自动" : "手动"}
      </Button>
      <Button onClick={props.onReset} size="icon" aria-label="reset" variant="ghost">
        <RotateCcw />
      </Button>
    </div>
  );
}

function ParticipantGrid({
  snap,
  selected,
  onPick,
}: {
  snap: AmrSnap;
  selected: Pid | null;
  onPick: (pid: Pid | null, name?: string) => void;
}) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {snap.participants.map((row) => {
        const proc = snap.actor.processes.find((p) => p.name === row.id);
        const on = proc != null && proc.pid === selected;
        return (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onPick(proc?.pid ?? row.pid, row.id)}
              className={cn(
                "flex h-full min-h-20 w-full flex-col items-start rounded-md px-3 py-2 text-left shadow-[0_0_0_1px_rgba(255,255,255,0.06)] transition-colors duration-150",
                on ? "bg-surface-2" : "bg-surface hover:bg-surface-2",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <span className={cn("size-1.5 shrink-0 rounded-full", presenceDot(row, proc))} />
                <span className="truncate font-mono text-xs text-fg">{row.id}</span>
                <span className="ml-auto font-mono text-[11px] text-subtle">{kindLabel(row.kind)}</span>
              </span>
              <span className="mt-2 font-mono text-[11px] text-muted">
                {row.presence}
                {proc?.status === "sleeping" ? " · wait" : ""}
                {row.generation > 0 ? ` · g${row.generation}` : ""}
                {row.restarts > 0 ? ` · r${row.restarts}` : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function DeliveryList({ deliveries }: { deliveries: Delivery[] }) {
  const rows = deliveries.slice(0, 12);
  if (rows.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted">还没有投递。发信，或等自动任务跑起来。</p>
    );
  }
  return (
    <ol className="mt-5 space-y-1.5">
      {rows.map((d) => (
        <li
          key={d.id}
          className="flex flex-wrap items-center gap-2 rounded-sm bg-surface px-3 py-2 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]"
        >
          <span className="font-mono text-[11px] text-subtle tabular-nums">{d.id}</span>
          <span className="min-w-0 truncate font-mono text-xs text-fg">
            {d.from} → {d.to}
          </span>
          <span className={cn("ml-auto font-mono text-[11px]", stateTone(d.state))}>
            {d.state}
          </span>
          <StateRail state={d.state} />
        </li>
      ))}
    </ol>
  );
}

const RAIL = ["accepted", "routed", "delivered", "acked"] as const;

function StateRail({ state }: { state: Delivery["state"] }) {
  const failed =
    state === "failed" ||
    state === "timed_out" ||
    state === "cancelled" ||
    state === "rejected";
  const idx = RAIL.indexOf(state as (typeof RAIL)[number]);
  return (
    <span className="flex w-full gap-1 sm:w-28 sm:shrink-0" aria-hidden>
      {RAIL.map((s, i) => (
        <span
          key={s}
          className={cn(
            "h-0.5 flex-1 rounded-full",
            failed && i === 3
              ? "bg-crash"
              : idx >= i
                ? "bg-ok"
                : "bg-border-strong",
          )}
        />
      ))}
    </span>
  );
}

function TreePanel({
  snap,
  selected,
  onSelect,
}: {
  snap: AmrSnap;
  selected: Pid | null;
  onSelect: (pid: Pid, name: string) => void;
}) {
  const procs = snap.actor.processes.filter((p) => !p.name.startsWith("timer:"));
  const pids = new Set(procs.map((p) => p.pid));
  const childrenOf = (pid: Pid) => procs.filter((p) => p.parent === pid);
  const shown = new Set<Pid>();

  function node(p: ProcSnap) {
    if (shown.has(p.pid)) return null;
    shown.add(p.pid);
    const kids = childrenOf(p.pid);
    const row = snap.participants.find((x) => x.id === p.name);
    return (
      <li key={p.pid}>
        <button
          type="button"
          onClick={() => onSelect(p.pid, p.name)}
          className={cn(
            "flex h-10 w-full items-center gap-2 rounded-sm px-2 text-left text-sm",
            selected === p.pid ? "bg-surface-2 text-fg" : "text-muted hover:text-fg",
          )}
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              !p.alive ? "bg-crash" : p.status === "sleeping" ? "bg-warn" : "bg-ok",
            )}
          />
          <span className="truncate font-mono text-xs">{p.name}</span>
          {row ? (
            <span className="font-mono text-[11px] text-subtle">{kindLabel(row.kind)}</span>
          ) : null}
          <span className="ml-auto font-mono text-[11px] text-subtle tabular-nums">
            #{p.pid}
          </span>
        </button>
        {kids.length > 0 && <ul className="pl-3.5">{kids.map((c) => node(c))}</ul>}
      </li>
    );
  }

  const roots = procs.filter((p) => p.parent == null || !pids.has(p.parent));
  const top = roots.filter((p) => p.name === "room_root_sup");
  const rest = roots.filter((p) => p.name !== "room_root_sup");

  return (
    <div className="h-full overflow-auto py-2">
      <ul>
        {(top.length ? top : roots).map((p) => node(p))}
        {rest.map((p) => node(p))}
      </ul>
    </div>
  );
}

function MailboxPanel({ proc }: { proc: ProcSnap | null }) {
  if (!proc) {
    return <p className="px-4 py-6 text-sm text-muted">点一个进程，查看它的邮箱。</p>;
  }
  return (
    <div className="h-full overflow-auto px-4 py-3">
      <p className="font-mono text-xs text-subtle">
        {proc.name} #{proc.pid} · {proc.status}
        {proc.restartCount > 0 ? ` · restarted ${proc.restartCount}` : ""}
      </p>
      <p className="mt-1 text-sm text-muted">
        {proc.alive
          ? proc.loc
            ? `perform ${proc.lastOp} @ ${proc.loc}`
            : "parked"
          : proc.reason}
      </p>
      <ol className="mt-4 space-y-2">
        {proc.mailbox.length === 0 && (
          <li className="text-sm text-subtle">邮箱空。receive 在等匹配的消息。</li>
        )}
        {proc.mailbox.map((m, i) => (
          <li
            key={i}
            className={cn(
              "rounded-sm px-3 py-2 font-mono text-xs",
              m.t === "EXIT"
                ? "bg-crash/15 text-crash"
                : m.t === "DOWN"
                  ? "bg-warn/15 text-warn"
                  : m.t === "Term"
                    ? "bg-receive/15 text-receive"
                    : "bg-surface-2 text-fg",
            )}
          >
            {labelOf(m)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LogPanel({
  events,
  actor,
}: {
  events: AmrSnap["events"];
  actor: TraceEvent[];
}) {
  return (
    <ol className="h-full overflow-auto px-3 py-2">
      {events.map((e, i) => (
        <li
          key={`a-${e.at}-${e.name}-${i}`}
          className="flex items-baseline gap-2 border-b border-border/60 py-1.5 font-mono text-[11px]"
        >
          <span className={cn("w-20 shrink-0", eventTone(e.name))}>{e.name}</span>
          <span className="min-w-0 truncate text-muted">{e.detail}</span>
        </li>
      ))}
      {events.length === 0 &&
        actor.map((e) => (
          <li
            key={e.seq}
            className="flex items-baseline gap-2 border-b border-border/60 py-1.5 font-mono text-[11px]"
          >
            <span className={cn("w-20 shrink-0", opColor(e.op))}>{e.op}</span>
            <span className="min-w-0 truncate text-muted">{e.detail}</span>
          </li>
        ))}
    </ol>
  );
}

function kindLabel(k: Kind): string {
  if (k === "agent") return "agent";
  if (k === "tool") return "tool";
  return "human";
}

function presenceDot(row: ParticipantRow, proc?: ProcSnap) {
  if (!proc?.alive || row.presence === "offline") return "bg-crash";
  if (row.presence === "restarting" || proc.status === "sleeping") return "bg-warn";
  if (row.presence === "busy" || row.presence === "degraded") return "bg-warn";
  return "bg-ok";
}

function stateTone(state: Delivery["state"]): string {
  switch (state) {
    case "acked":
      return "text-ok";
    case "rejected":
    case "failed":
    case "timed_out":
      return "text-crash";
    case "cancelled":
      return "text-warn";
    case "delivered":
    case "routed":
      return "text-receive";
    default:
      return "text-muted";
  }
}

function eventTone(name: string): string {
  if (name === "acked" || name === "join" || name === "restarted") return "text-ok";
  if (
    name === "drop" ||
    name === "failed" ||
    name === "down" ||
    name === "timed_out" ||
    name === "rejected"
  ) {
    return "text-crash";
  }
  if (name === "cancelled" || name === "presence") return "text-warn";
  return "text-subtle";
}

function opColor(op: TraceOp): string {
  switch (op) {
    case "spawn":
    case "restart":
      return "text-spawn";
    case "send":
      return "text-send";
    case "receive":
      return "text-receive";
    case "crash":
    case "drop":
      return "text-crash";
    default:
      return "text-subtle";
  }
}
