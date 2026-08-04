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
  OUTIL: "outillage",
  OUTIL_FABRICANT: "outillage",
  OUTIL_FOURNISSEUR: "outillage",
  OUTIL_REVETEMENT: "outillage",
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

export type RealtimeModuleAccessProfile = {
  is_superadmin: boolean;
  modules: ReadonlyArray<{ module_key: string; allowed: boolean }>;
};

/** Shared fail-closed module decision used by room ACLs and HTTP lock ACLs. */
export function realtimeAccessProfileAllowsModule(
  profile: RealtimeModuleAccessProfile | null,
  moduleKey: string
): boolean {
  return Boolean(profile && (
    profile.is_superadmin
    || profile.modules.some((entry) => entry.module_key === moduleKey && entry.allowed)
  ));
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

/**
 * Canonicalizes every subscription shape that may cross the durable control
 * plane. Keeping this in the room policy makes persistence and Socket.IO use
 * the exact same allow-list instead of accepting structurally valid targets
 * that no recipient can ever authorize.
 */
export function normalizeRealtimeSubscription(value: unknown): RealtimeSubscription | null {
  if (!isRecord(value) || typeof value.scope !== "string") return null;

  if (value.scope === "user") {
    if (!hasOnlyKeys(value, ["scope", "userId"])) return null;
    const userId = value.userId;
    return typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0
      ? { scope: "user", userId }
      : null;
  }

  if (value.scope === "capability") {
    if (!hasOnlyKeys(value, ["scope", "capability"])) return null;
    if (value.capability === REALTIME_CAPABILITIES.AUDIT_READ) {
      return { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ };
    }
    if (value.capability === REALTIME_CAPABILITIES.CHAT_PRESENCE) {
      return { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE };
    }
    return null;
  }

  return normalizeClientRealtimeSubscription(value);
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

/** Parses only room names produced by realtimeRoomName; Socket.IO private rooms return null. */
export function parseRealtimeRoomName(room: string): RealtimeSubscription | null {
  if (room.startsWith("rt:module:")) {
    const moduleKey = normalizeRealtimeModuleKey(room.slice("rt:module:".length));
    return moduleKey ? { scope: "module", moduleKey } : null;
  }
  if (room.startsWith("rt:entity:")) {
    const [entityType, entityId, ...extra] = room.slice("rt:entity:".length).split(":");
    if (extra.length > 0) return null;
    return normalizeClientRealtimeSubscription({ scope: "entity", entityType, entityId });
  }
  if (room.startsWith("rt:station:")) {
    const [kind, id, ...extra] = room.slice("rt:station:".length).split(":");
    if (extra.length > 0) return null;
    return normalizeClientRealtimeSubscription({ scope: "station", kind, id });
  }
  if (room.startsWith("rt:user:")) {
    const raw = room.slice("rt:user:".length);
    const userId = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(userId) && userId > 0
      ? { scope: "user", userId }
      : null;
  }
  if (room === `rt:capability:${REALTIME_CAPABILITIES.AUDIT_READ}`) {
    return { scope: "capability", capability: REALTIME_CAPABILITIES.AUDIT_READ };
  }
  if (room === `rt:capability:${REALTIME_CAPABILITIES.CHAT_PRESENCE}`) {
    return { scope: "capability", capability: REALTIME_CAPABILITIES.CHAT_PRESENCE };
  }
  return null;
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
