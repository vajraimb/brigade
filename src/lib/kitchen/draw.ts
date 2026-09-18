import { labelOf } from "../actor/runtime";
import type { Msg, Pid, ProcSnap, Snapshot } from "../actor/types";
import { layoutOf, STATION_PADS, subtitleOf, type NodePos } from "./layout";

type Tokens = {
  bg: string;
  surface: string;
  surface2: string;
  fg: string;
  muted: string;
  subtle: string;
  accent: string;
  spawn: string;
  send: string;
  receive: string;
  crash: string;
  ok: string;
  warn: string;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
};

type Laid = { proc: ProcSnap; pos: NodePos };
type Pt = { x: number; y: number };

export class KitchenView {
  particles: Particle[] = [];
  seenDeaths = new Set<string>();
  private tok: Tokens | null = null;

  tokens(el: HTMLElement): Tokens {
    if (this.tok) return this.tok;
    const s = getComputedStyle(el);
    const v = (n: string) => s.getPropertyValue(n).trim();
    this.tok = {
      bg: v("--color-bg") || "#0b0c0d",
      surface: v("--color-surface") || "#121314",
      surface2: v("--color-surface-2") || "#1a1c1d",
      fg: v("--color-fg") || "#e6e4df",
      muted: v("--color-muted") || "#8c8e8b",
      subtle: v("--color-subtle") || "#6a6c6a",
      accent: v("--color-accent") || "#b4b8b2",
      spawn: v("--color-spawn") || "#d8d6d1",
      send: v("--color-send") || "#9aa7a0",
      receive: v("--color-receive") || "#7f8c94",
      crash: v("--color-crash") || "#c45c4a",
      ok: v("--color-ok") || "#6f9e7a",
      warn: v("--color-warn") || "#c4a574",
    };
    return this.tok;
  }

  hit(canvas: HTMLCanvasElement, snap: Snapshot, clientX: number, clientY: number): Pid | null {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const laid = this.layout(snap);
    let best: { pid: Pid; d: number } | null = null;
    for (const node of laid) {
      const p = toPx(node.pos, rect.width, rect.height);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 28 && (!best || d < best.d)) best = { pid: node.proc.pid, d };
    }
    return best?.pid ?? null;
  }

  draw(
    canvas: HTMLCanvasElement,
    snap: Snapshot,
    selected: Pid | null,
    dt: number,
    clock: number,
  ) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const t = this.tokens(canvas);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    ctx.fillStyle = t.bg;
    ctx.fillRect(0, 0, cssW, cssH);
    drawGrid(ctx, cssW, cssH, t);
    drawVignette(ctx, cssW, cssH);

    const laid = this.layout(snap);
    const byPid = new Map<Pid, Laid>();
    for (const n of laid) byPid.set(n.proc.pid, n);

    for (const pad of STATION_PADS) {
      const c = toPx({ x: pad.x, y: pad.y }, cssW, cssH);
      const pw = pad.w * cssW;
      const ph = pad.h * cssH;
      roundRect(ctx, c.x - pw * 0.5, c.y - ph * 0.42, pw, ph, 16);
      ctx.fillStyle = hexA(t.surface, 0.72);
      ctx.fill();
      ctx.strokeStyle = hexA(t.fg, 0.08);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.font = "500 10px 'IBM Plex Sans', sans-serif";
      ctx.fillStyle = t.subtle;
      ctx.textAlign = "center";
      ctx.fillText(pad.name.toUpperCase(), c.x, c.y + ph * 0.4);
    }

    for (const node of laid) {
      if (node.proc.parent == null) continue;
      const parent = byPid.get(node.proc.parent);
      if (!parent) continue;
      const a = toPx(parent.pos, cssW, cssH);
      const b = toPx(node.pos, cssW, cssH);
      const busy = snap.inFlight.some(
        (f) =>
          (f.from === parent.proc.pid && f.to === node.proc.pid) ||
          (f.from === node.proc.pid && f.to === parent.proc.pid),
      );
      ctx.beginPath();
      const cpt = ctrl(a, b);
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cpt.x, cpt.y, b.x, b.y);
      ctx.strokeStyle = busy ? hexA(t.send, 0.55) : hexA(t.fg, 0.1);
      ctx.lineWidth = busy ? 1.4 : 1;
      ctx.stroke();
    }

    this.spawnDeaths(laid, cssW, cssH, t);
    if (!reduced) this.stepParticles(dt);
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    for (const f of snap.inFlight) {
      const from = byPid.get(f.from);
      const to = byPid.get(f.to);
      if (!from || !to) continue;
      const a = toPx(from.pos, cssW, cssH);
      const b = toPx(to.pos, cssW, cssH);
      const p = quadPoint(a, ctrl(a, b), b, f.progress);
      drawCapsule(ctx, p.x, p.y, ticketLabel(f.msg), t);
    }

    for (const node of laid) {
      drawNode(ctx, node, toPx(node.pos, cssW, cssH), t, selected, clock, snap.now, reduced);
    }

    ctx.textAlign = "left";
    ctx.font = "500 10px 'IBM Plex Mono', monospace";
    ctx.fillStyle = t.subtle;
    ctx.fillText(`${snap.reductions} reductions`, 16, cssH - 14);
    const live = snap.processes.filter((p) => p.alive).length;
    ctx.textAlign = "right";
    ctx.fillText(`${live} alive`, cssW - 16, cssH - 14);
  }

  private layout(snap: Snapshot): Laid[] {
    const orders = snap.processes
      .filter((p) => p.name.startsWith("order-"))
      .map((p) => p.pid);
    return snap.processes.map((proc) => ({ proc, pos: layoutOf(proc, orders) }));
  }

  private spawnDeaths(laid: Laid[], W: number, H: number, t: Tokens) {
    for (const node of laid) {
      if (node.proc.alive || node.proc.diedAt == null) continue;
      const key = `${node.proc.pid}:${node.proc.diedAt}`;
      if (this.seenDeaths.has(key)) continue;
      this.seenDeaths.add(key);
      const p = toPx(node.pos, W, H);
      for (let i = 0; i < 14; i++) {
        const a = (Math.PI * 2 * i) / 14 + Math.random() * 0.3;
        const sp = 40 + Math.random() * 80;
        this.particles.push({
          x: p.x,
          y: p.y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0.45 + Math.random() * 0.25,
          max: 0.7,
          color: t.crash,
        });
      }
    }
    if (this.seenDeaths.size > 80) this.seenDeaths.clear();
  }

  private stepParticles(dt: number) {
    const s = dt / 1000;
    this.particles = this.particles.filter((p) => {
      p.life -= s;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vy += 40 * s;
      p.vx *= 0.98;
      return p.life > 0;
    });
  }
}

function toPx(pos: { x: number; y: number }, W: number, H: number): Pt {
  return { x: pos.x * W, y: pos.y * H };
}

function ctrl(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 18 };
}

function quadPoint(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

function drawGrid(ctx: CanvasRenderingContext2D, W: number, H: number, t: Tokens) {
  ctx.strokeStyle = hexA(t.fg, 0.035);
  ctx.lineWidth = 1;
  const step = 28;
  ctx.beginPath();
  for (let x = 0; x <= W; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = 0; y <= H; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();
}

function drawVignette(ctx: CanvasRenderingContext2D, W: number, H: number) {
  const g = ctx.createRadialGradient(
    W * 0.5,
    H * 0.42,
    40,
    W * 0.5,
    H * 0.5,
    Math.max(W, H) * 0.72,
  );
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  node: Laid,
  p: Pt,
  t: Tokens,
  selected: Pid | null,
  clock: number,
  now: number,
  reduced: boolean,
) {
  const { proc, pos } = node;
  const pulse = reduced ? 1 : 0.5 + 0.5 * Math.sin(clock / 420);
  const r = pos.role === "sup" ? 16 : pos.role === "order" ? 11 : 14;

  if (selected === proc.pid) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 8, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(t.accent, 0.55);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  if (proc.status === "receiving" && proc.alive) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = hexA(t.receive, 0.25 + 0.25 * pulse);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = proc.alive ? t.surface2 : hexA(t.crash, 0.18);
  ctx.fill();
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = ringColor(proc, t);
  ctx.stroke();

  const frac = cookFrac(proc, now);
  if (frac != null) {
    ctx.beginPath();
    ctx.strokeStyle = t.warn;
    ctx.lineWidth = 2;
    ctx.arc(p.x, p.y, r + 3.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
  }

  const mail = proc.mailbox.length;
  if (mail > 0 && proc.alive) {
    for (let i = 0; i < Math.min(mail, 5); i++) {
      ctx.fillStyle = hexA(t.send, 0.7);
      ctx.fillRect(p.x + r + 4, p.y - 8 + i * 4, 7, 2.5);
    }
  }

  ctx.textAlign = "center";
  ctx.font = "500 11px 'IBM Plex Sans', sans-serif";
  ctx.fillStyle = proc.alive ? t.fg : t.crash;
  ctx.fillText(shortName(proc.name), p.x, p.y + r + 14);
  ctx.font = "400 9px 'IBM Plex Mono', monospace";
  ctx.fillStyle = t.subtle;
  ctx.fillText(`#${proc.pid}`, p.x, p.y + r + 26);
  const sub = subtitleOf(proc.name);
  if (proc.alive && sub && pos.role === "sup") {
    ctx.fillText(sub, p.x, p.y + r + 38);
  }
  if (!proc.alive && proc.reason) {
    ctx.fillStyle = t.crash;
    ctx.fillText(proc.reason, p.x, p.y + r + 38);
  }
}

function cookFrac(proc: ProcSnap, now: number): number | null {
  if (!proc.alive || proc.status !== "sleeping") return null;
  if (proc.sleepMs == null || proc.sleepFrom == null) return null;
  return Math.min(1, Math.max(0, (now - proc.sleepFrom) / proc.sleepMs));
}

function ringColor(proc: ProcSnap, t: Tokens): string {
  if (!proc.alive) return t.crash;
  if (proc.status === "sleeping") return t.warn;
  if (proc.status === "receiving") return t.receive;
  if (proc.lastOp === "send") return t.send;
  if (proc.lastOp === "spawn") return t.spawn;
  return hexA(t.fg, 0.35);
}

function drawCapsule(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  t: Tokens,
) {
  ctx.font = "500 9px 'IBM Plex Mono', monospace";
  const tw = ctx.measureText(text).width;
  const w = tw + 12;
  const h = 16;
  roundRect(ctx, x - w / 2, y - h / 2, w, h, 8);
  ctx.fillStyle = t.surface2;
  ctx.fill();
  ctx.strokeStyle = hexA(t.send, 0.7);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = t.fg;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
  ctx.textBaseline = "alphabetic";
}

function ticketLabel(msg: Msg): string {
  if (msg.t === "Ticket" || msg.t === "Plated" || msg.t === "Ready") {
    return msg.item.toUpperCase();
  }
  if (msg.t === "StartChild") return msg.item.name.toUpperCase();
  if (msg.t === "EXIT") return "EXIT";
  if (msg.t === "Crash") return "CRASH";
  return labelOf(msg).slice(0, 10);
}

function shortName(name: string): string {
  if (name.startsWith("order-")) {
    const parts = name.split("-");
    return `order ${parts[1] ?? ""}`;
  }
  return name;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hexA(hex: string, a: number): string {
  const raw = hex.trim();
  if (raw.startsWith("rgb") || raw.startsWith("color")) {
    return raw;
  }
  const n = raw.replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
