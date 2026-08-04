import { getModuleCatalogEntry } from "../../module/access-control/domain/module-catalog";

export const REALTIME_CAPABILITIES = {
  CHAT_PRESENCE: "chat:presence",
  AUDIT_READ: "audit:read",
} as const;

export type RealtimeCapability = (typeof REALTIME_CAPABILITIES)[keyof typeof REALTIME_CAPABILITIES];

export type ClientRealtimeSubscription =
  | { scope: "module"; moduleKey: string }
  | { scope: "entity"; entityType: string; entityId: string }
  | { scope: "station"; kind: "STATION" | "MACHINE" | "OF"; id: string };

export type RealtimeSubscription =
  | ClientRealtimeSubscription
  | { scope: "user"; userId: number }
  | { scope: "capability"; capability: RealtimeCapability };

const MODULE_ALIASES: Readonly<Record<string, string>> = {
  commandes: "commandes-clients",
  planning: "production",
  receptions: "qualite",
};

const ENTITY_MODULES: Readonly<Record<string, string>> = {
  BON_LIVRAISON: "livraisons",
  CAPA: "qualite",
  COMMANDE_CLIENT: "commandes-clients",
  METROLOGIE_EQUIPEMENT: "metrologie",
  NCR: "qualite",
  OF: "production",
  PIECE_TECHNIQUE: "pieces-techniques",
  PLANNING_EVENTS: "production",
  RECEPTION: "qualite",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function normalizeEntityType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(normalized) ? normalized : null;
}

function normalizeOpaqueId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[a-zA-Z0-9_-]{1,128}$/.test(normalized) ? normalized : null;
}

export function normalizeRealtimeModuleKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(normalized)) return null;
  const canonical = MODULE_ALIASES[normalized] ?? normalized;
  return getModuleCatalogEntry(canonical) ? canonical : null;
}

export function moduleForRealtimeEntity(entityType: unknown): string | null {
  const normalized = normalizeEntityType(entityType);
  return normalized ? ENTITY_MODULES[normalized] ?? null : null;
}

export function normalizeClientRealtimeSubscription(value: unknown): ClientRealtimeSubscription | null {
  if (!isRecord(value) || typeof value.scope !== "string") return null;

  if (value.scope === "module") {
    if (!hasOnlyKeys(value, ["scope", "moduleKey"])) return null;
    const moduleKey = normalizeRealtimeModuleKey(value.moduleKey);
    return moduleKey ? { scope: "module", moduleKey } : null;
  }

  if (value.scope === "entity") {
    if (!hasOnlyKeys(value, ["scope", "entityType", "entityId"])) return null;
    const entityType = normalizeEntityType(value.entityType);
    const entityId = normalizeOpaqueId(value.entityId);
    if (!entityType || !entityId || !moduleForRealtimeEntity(entityType)) return null;
    return { scope: "entity", entityType, entityId };
  }

  if (value.scope === "station") {
    if (!hasOnlyKeys(value, ["scope", "kind", "id"])) return null;
    const kind = value.kind;
    const id = normalizeOpaqueId(value.id);
    if ((kind !== "STATION" && kind !== "MACHINE" && kind !== "OF") || !id) return null;
    return { scope: "station", kind, id };
  }

  return null;
}

export function realtimeRoomName(subscription: RealtimeSubscription): string {
  switch (subscription.scope) {
    case "module":
      return `rt:module:${subscription.moduleKey}`;
    case "entity":
      return `rt:entity:${subscription.entityType}:${subscription.entityId}`;
    case "station":
      return `rt:station:${subscription.kind}:${subscription.id}`;
    case "user":
      return `rt:user:${subscription.userId}`;
    case "capability":
      return `rt:capability:${subscription.capability}`;
  }
}

export function realtimeSubscriptionKey(subscription: RealtimeSubscription): string {
  return realtimeRoomName(subscription);
}

export function entityRealtimeSubscription(
  entityType: string,
  entityId: string
): Extract<ClientRealtimeSubscription, { scope: "entity" }> | null {
  const normalized = normalizeClientRealtimeSubscription({ scope: "entity", entityType, entityId });
  return normalized?.scope === "entity" ? normalized : null;
}

export function moduleRealtimeSubscription(
  moduleKey: string
): Extract<ClientRealtimeSubscription, { scope: "module" }> | null {
  const normalized = normalizeClientRealtimeSubscription({ scope: "module", moduleKey });
  return normalized?.scope === "module" ? normalized : null;
}

export function stationLegacyRoom(subscription: Extract<ClientRealtimeSubscription, { scope: "station" }>): string {
  return `${subscription.kind}:${subscription.id}`;
}
