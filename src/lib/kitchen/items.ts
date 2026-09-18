import type { MenuItem } from "../actor/types";

export const MENU: MenuItem[] = [
  { id: "smash", name: "Smash", station: "grill", cookMs: 1100, poison: false },
  { id: "steak", name: "Steak", station: "grill", cookMs: 1600, poison: false },
  { id: "fries", name: "Fries", station: "fry", cookMs: 900, poison: false },
  { id: "rings", name: "Rings", station: "fry", cookMs: 1000, poison: false },
  { id: "poison", name: "Poison", station: "grill", cookMs: 240, poison: true },
];

export const NORMAL_MENU = MENU.filter((m) => !m.poison);
export const POISON = MENU.find((m) => m.poison)!;

export function randomNormal(): MenuItem {
  return NORMAL_MENU[Math.floor(Math.random() * NORMAL_MENU.length)]!;
}
