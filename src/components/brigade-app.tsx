import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pause,
  Play,
  Flame,
  Plus,
  Skull,
  RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SourceView } from "@/components/source-view";
import { KitchenSim } from "@/lib/kitchen/sim";
import { KitchenView } from "@/lib/kitchen/draw";
import { MENU, POISON, randomNormal } from "@/lib/kitchen/items";
import { fileForProcess, type SourceFile } from "@/lib/kitchen/sources";
import { labelOf } from "@/lib/actor/runtime";
import type { Pid, ProcSnap, Snapshot, TraceEvent, TraceOp } from "@/lib/actor/types";
import { cn } from "@/lib/utils";

type Tab = "tree" | "mailbox" | "source" | "log";

const SPEEDS = [0.5, 1, 2] as const;

export function BrigadeApp() {
  const simRef = useRef<KitchenSim | null>(null);
  if (simRef.current == null) simRef.current = new KitchenSim();
  const viewRef = useRef(new KitchenView());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectedRef = useRef<Pid | null>(null);
  const pausedRef = useRef(false);
  const speedRef = useRef(1);

  const [snap, setSnap] = useState<Snapshot>(() => simRef.current!.snapshot());
  const [selected, setSelected] = useState<Pid | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [tab, setTab] = useState<Tab>("tree");
  const [file, setFile] = useState<SourceFile>("kitchen.ml");
  const [auto, setAuto] = useState(true);

  selectedRef.current = selected;
  pausedRef.current = paused;
  speedRef.current = speed;

  useEffect(() => {
    const sim = simRef.current!;
    let last = performance.now();
    let ui = 0;
    let trickle = 0;
    let raf = 0;
    const loop = (t: number) => {
      const raw = Math.min(100, t - last);
      last = t;
      if (!pausedRef.current) {
        sim.tick(raw * speedRef.current);
        trickle += raw * speedRef.current;
        if (auto && trickle > 2800) {
          trickle = 0;
          sim.placeOrder(randomNormal());
        }
      }
      const shot = sim.snapshot();
      const canvas = canvasRef.current;
      if (canvas) viewRef.current.draw(canvas, shot, selectedRef.current, raw, t);
      if (t - ui > 90) {
        ui = t;
        setSnap(shot);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [auto]);

  useEffect(() => {
    const sim = simRef.current!;
    const id = window.setTimeout(() => {
      sim.placeOrder(MENU[0]!);
      sim.placeOrder(MENU[2]!);
    }, 600);
    return () => window.clearTimeout(id);
  }, []);

  const selectedProc = useMemo(
    () => snap.processes.find((p) => p.pid === selected) ?? null,
    [snap, selected],
  );

  const liveSelected =
    selectedProc?.alive
      ? selectedProc
      : selectedProc
        ? snap.processes.find((p) => p.name === selectedProc.name && p.alive) ?? selectedProc
        : null;

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as unknown as { __brigade?: unknown }).__brigade = {
      snapshot: () => simRef.current?.snapshot(),
      alive: () =>
        simRef.current?.snapshot().processes.filter((p) => p.alive).length ?? 0,
    };
  }, []);

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pid = viewRef.current.hit(canvas, snap, e.clientX, e.clientY);
    setSelected(pid);
    if (pid != null) {
      const proc = snap.processes.find((p) => p.pid === pid);
      if (proc) setFile(fileForProcess(proc.name));
      setTab("mailbox");
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <header className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
              OCaml Effect + Eio
            </p>
            <h1 className="mt-0.5 text-xl font-medium tracking-[-0.03em] sm:mt-1 sm:text-3xl">
              BRIGADE
            </h1>
            <p className="mt-1 hidden max-w-xl text-sm leading-snug text-muted sm:block">
              后厨是一棵监督树。工单是消息，厨师是进程。灶台着火时不救厨师——supervisor 再 spawn 一个。
            </p>
          </div>
          <Controls
            paused={paused}
            speed={speed}
            auto={auto}
            canCrash={liveSelected?.alive === true}
            onPause={() => setPaused((p) => !p)}
            onSpeed={() =>
              setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]!)
            }
            onOrder={() => simRef.current?.placeOrder(randomNormal())}
            onPoison={() => simRef.current?.placeOrder(POISON)}
            onCrash={() => {
              if (liveSelected?.alive) simRef.current?.crash(liveSelected.pid);
            }}
            onAuto={() => setAuto((a) => !a)}
            onReset={() => {
              simRef.current = new KitchenSim();
              setSnap(simRef.current.snapshot());
              setSelected(null);
            }}
          />
        </div>
        <Primitives />
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative min-h-[320px] flex-1 lg:min-h-0">
          <canvas
            ref={canvasRef}
            className="block h-full min-h-[280px] w-full touch-none sm:min-h-[320px] lg:min-h-full"
            onClick={onCanvasClick}
            role="img"
            aria-label="Kitchen actor topology"
          />
          <p className="pointer-events-none absolute top-2 left-3 hidden font-mono text-[11px] text-subtle sm:block">
            点击节点查看邮箱 · 崩溃选中进程
          </p>
        </section>

        <aside className="flex min-h-[280px] w-full shrink-0 flex-col border-t border-border lg:w-[380px] lg:border-t-0 lg:border-l">
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
                selected={liveSelected?.pid ?? null}
                onSelect={setSelected}
              />
            )}
            {tab === "mailbox" && <MailboxPanel proc={liveSelected} />}
            {tab === "source" && (
              <SourceView
                loc={liveSelected?.loc ?? snap.lastLoc}
                file={file}
                onFile={setFile}
              />
            )}
            {tab === "log" && <LogPanel events={snap.events} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function Controls(props: {
  paused: boolean;
  speed: number;
  auto: boolean;
  canCrash: boolean;
  onPause: () => void;
  onSpeed: () => void;
  onOrder: () => void;
  onPoison: () => void;
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
      <Button onClick={props.onOrder} size="md" variant="primary">
        <Plus />
        催单
      </Button>
      <Button onClick={props.onPoison} size="md" variant="danger">
        <Skull />
        毒单
      </Button>
      <Button onClick={props.onCrash} size="md" variant="danger" disabled={!props.canCrash}>
        <Flame />
        崩溃
      </Button>
      <Button onClick={props.onAuto} size="md" variant={props.auto ? "secondary" : "ghost"}>
        {props.auto ? "自动开档" : "手动"}
      </Button>
      <Button onClick={props.onReset} size="icon" aria-label="reset" variant="ghost">
        <RotateCcw />
      </Button>
    </div>
  );
}

function Primitives() {
  const items = [
    { id: "spawn", title: "spawn", body: "fork 一个 fiber，返回 Pid" },
    { id: "send", title: "send", body: "异步投递到邮箱，不等待" },
    { id: "receive", title: "receive", body: "按模式取出；不匹配的留下" },
    { id: "supervisor", title: "supervisor", body: "trap EXIT，按策略重启" },
  ] as const;
  return (
    <ul className="flex gap-2 overflow-x-auto pb-0.5 lg:grid lg:grid-cols-4 lg:overflow-visible">
      {items.map((it) => (
        <li
          key={it.id}
          className="min-w-[9.5rem] shrink-0 rounded-md bg-surface px-3 py-2 shadow-[0_0_0_1px_rgba(255,255,255,0.06)] lg:min-w-0"
        >
          <p className="font-mono text-xs text-accent">{it.title}</p>
          <p className="mt-0.5 text-xs leading-snug text-muted">{it.body}</p>
        </li>
      ))}
    </ul>
  );
}

function TreePanel({
  snap,
  selected,
  onSelect,
}: {
  snap: Snapshot;
  selected: Pid | null;
  onSelect: (pid: Pid) => void;
}) {
  const pids = new Set(snap.processes.map((p) => p.pid));
  const childrenOf = (pid: Pid) => snap.processes.filter((p) => p.parent === pid);
  const shown = new Set<Pid>();

  function node(p: ProcSnap, depth: number) {
    if (shown.has(p.pid)) return null;
    shown.add(p.pid);
    const kids = childrenOf(p.pid);
    return (
      <li key={p.pid}>
        <button
          type="button"
          onClick={() => onSelect(p.pid)}
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
          <span className="ml-auto font-mono text-[11px] text-subtle tabular-nums">
            #{p.pid}
          </span>
        </button>
        {kids.length > 0 && (
          <ul className="pl-3.5">{kids.map((c) => node(c, depth + 1))}</ul>
        )}
      </li>
    );
  }

  const roots = snap.processes.filter(
    (p) => p.parent == null || !pids.has(p.parent),
  );
  const top = roots.filter((p) => p.name === "brigade_sup");
  const rest = roots.filter((p) => p.name !== "brigade_sup");

  return (
    <div className="h-full overflow-auto py-2">
      <ul>
        {(top.length ? top : roots).map((p) => node(p, 0))}
        {rest.map((p) => node(p, 0))}
      </ul>
    </div>
  );
}

function MailboxPanel({ proc }: { proc: ProcSnap | null }) {
  if (!proc) {
    return (
      <p className="px-4 py-6 text-sm text-muted">点画布上的进程，查看它的邮箱。</p>
    );
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
            className="rounded-sm bg-surface-2 px-3 py-2 font-mono text-xs text-fg"
          >
            {labelOf(m)}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LogPanel({ events }: { events: TraceEvent[] }) {
  return (
    <ol className="h-full overflow-auto px-3 py-2">
      {events.map((e) => (
        <li
          key={e.seq}
          className="flex items-baseline gap-2 border-b border-border/60 py-1.5 font-mono text-[11px]"
        >
          <span className={cn("w-16 shrink-0", opColor(e.op))}>{e.op}</span>
          <span className="min-w-0 truncate text-muted">{e.detail}</span>
        </li>
      ))}
    </ol>
  );
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
