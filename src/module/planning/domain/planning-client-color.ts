import { isReservedPlanningClientColor } from "./planning-client-color-policy";

/** Shared workshop palette. Mirrored by frontend runtime-colors.ts. Red is an alert. */
export const PLANNING_CLIENT_PALETTE = [
  "#DBEAFE", "#CCFBF1", "#FFEDD5", "#EDE9FE", "#E0F2FE", "#F3E8FF",
  "#FCE7F3", "#E0E7FF", "#DCFCE7", "#FEF4CC", "#FAE8FF", "#CFFAFE",
] as const;

/** Retain existing pastels exactly; lift darker custom colors without changing their hue. */
export function planningClientPastel(raw: string | null | undefined): string | null {
  if (!raw || !/^#[0-9a-f]{6}$/i.test(raw)) return null;
  const color = raw.toUpperCase();
  if (isReservedPlanningClientColor(color)) return null;
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const min = Math.min(...rgb);
  if (min >= 204) return color;
  const white = (204 - min) / (255 - min);
  return "#" + rgb.map(v => Math.round(v + (255 - v) * white).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function resolvePlanningClientColor(clientId: string | null, clientName: string | null, assigned?: string | null): string | null {
  if (!clientId?.trim() && !clientName?.trim()) return null;
  const saved = planningClientPastel(assigned);
  if (saved) return saved;
  const name = (clientName ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (name === "vision systems") return PLANNING_CLIENT_PALETTE[0];
  if (name === "crp") return PLANNING_CLIENT_PALETTE[1];
  const key = clientId?.trim() ? `id:${clientId.trim()}` : `name:${(clientName ?? "").trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return PLANNING_CLIENT_PALETTE[(hash >>> 0) % PLANNING_CLIENT_PALETTE.length];
}
