import type { Pid, ProcSnap } from "../actor/types";

export type Role = "sup" | "cook" | "order" | "other";

export type NodePos = { x: number; y: number; role: Role; label: string };

const FIXED: Record<string, NodePos> = {
  brigade_sup: { x: 0.5, y: 0.13, role: "sup", label: "brigade_sup" },
  line_sup: { x: 0.28, y: 0.34, role: "sup", label: "line_sup" },
  service_sup: { x: 0.72, y: 0.34, role: "sup", label: "service_sup" },
  grill: { x: 0.16, y: 0.6, role: "cook", label: "grill" },
  fry: { x: 0.38, y: 0.6, role: "cook", label: "fry" },
  pass: { x: 0.6, y: 0.6, role: "cook", label: "pass" },
};

export function roleOf(name: string): Role {
  if (name.endsWith("_sup")) return "sup";
  if (name === "grill" || name === "fry" || name === "pass") return "cook";
  if (name.startsWith("order-")) return "order";
  return "other";
}

export function subtitleOf(name: string): string {
  switch (name) {
    case "brigade_sup":
      return "one_for_one";
    case "line_sup":
      return "sous · one_for_one";
    case "service_sup":
      return "simple_one_for_one";
    case "grill":
      return "selective receive";
    case "fry":
      return "selective receive";
    case "pass":
      return "expedite";
    default:
      if (name.startsWith("order-")) return "temporary";
      return "";
  }
}

export function layoutOf(
  proc: ProcSnap,
  orders: Pid[],
): NodePos {
  const fixed = FIXED[proc.name];
  if (fixed) return fixed;
  if (proc.name.startsWith("order-")) {
    const idx = Math.max(0, orders.indexOf(proc.pid));
    const n = Math.max(orders.length, 1);
    const x = 0.1 + (0.8 * (idx + 0.5)) / n;
    return { x, y: 0.86, role: "order", label: proc.name };
  }
  return { x: 0.5, y: 0.5, role: "other", label: proc.name };
}

export const STATION_PADS: { name: string; x: number; y: number; w: number; h: number }[] = [
  { name: "grill", x: 0.16, y: 0.6, w: 0.2, h: 0.22 },
  { name: "fry", x: 0.38, y: 0.6, w: 0.2, h: 0.22 },
  { name: "pass", x: 0.6, y: 0.6, w: 0.2, h: 0.22 },
];
