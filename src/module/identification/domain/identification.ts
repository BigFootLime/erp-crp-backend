import { HttpError } from "../../../utils/httpError";

export const IDENTIFICATION_CONTRACT_VERSION = 1 as const;
export const IDENTIFICATION_ENTITY_TYPES = [
  "STOCK_ARTICLE",
  "STOCK_LOT",
  "STOCK_LOCATION",
  "WORK_ORDER",
  "PURCHASE_ORDER",
  "RECEPTION",
  "QUALITY_CONTROL",
  "TOOL",
  "DELIVERY",
] as const;
export type IdentificationEntityType = (typeof IDENTIFICATION_ENTITY_TYPES)[number];

export const IDENTIFICATION_FLOWS = [
  "RECEIVE",
  "PUTAWAY",
  "TRANSFER",
  "CONSUME",
  "START_WORK_ORDER",
  "QUALITY_CONTROL",
  "TOOL_ISSUE",
  "TOOL_RETURN",
  "SHIP",
  "TRACEABILITY",
] as const;
export type IdentificationFlow = (typeof IDENTIFICATION_FLOWS)[number];

export const IDENTIFICATION_SYMBOLOGIES = ["QR_CODE", "CODE_128", "DATA_MATRIX"] as const;
export type IdentificationSymbology = (typeof IDENTIFICATION_SYMBOLOGIES)[number];
export const IDENTIFICATION_LABEL_PROFILES = ["STANDARD_50X30", "SMALL_30X15", "A4_SHEET"] as const;
export type IdentificationLabelProfile = (typeof IDENTIFICATION_LABEL_PROFILES)[number];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PAYLOAD_RE = new RegExp(`^CERP:${IDENTIFICATION_CONTRACT_VERSION}:(${UUID})$`, "i");

export const FLOW_ENTITY_TYPES: Readonly<Record<IdentificationFlow, readonly IdentificationEntityType[]>> = {
  RECEIVE: ["PURCHASE_ORDER", "RECEPTION", "STOCK_ARTICLE", "STOCK_LOT"],
  PUTAWAY: ["STOCK_ARTICLE", "STOCK_LOT", "STOCK_LOCATION", "RECEPTION"],
  TRANSFER: ["STOCK_ARTICLE", "STOCK_LOT", "STOCK_LOCATION"],
  CONSUME: ["STOCK_ARTICLE", "STOCK_LOT", "WORK_ORDER"],
  START_WORK_ORDER: ["WORK_ORDER"],
  QUALITY_CONTROL: ["QUALITY_CONTROL", "STOCK_LOT", "WORK_ORDER", "RECEPTION"],
  TOOL_ISSUE: ["TOOL", "WORK_ORDER"],
  TOOL_RETURN: ["TOOL", "WORK_ORDER"],
  SHIP: ["DELIVERY", "STOCK_LOT"],
  TRACEABILITY: IDENTIFICATION_ENTITY_TYPES,
};

const ENTITY_MODULE: Readonly<Record<IdentificationEntityType, string>> = {
  STOCK_ARTICLE: "stock",
  STOCK_LOT: "stock",
  STOCK_LOCATION: "stock",
  WORK_ORDER: "production",
  PURCHASE_ORDER: "commandes-fournisseurs",
  RECEPTION: "qualite",
  QUALITY_CONTROL: "qualite",
  TOOL: "outillage",
  DELIVERY: "livraisons",
};

const ENTITY_PREFIX: Readonly<Record<IdentificationEntityType, string>> = {
  STOCK_ARTICLE: "ART",
  STOCK_LOT: "LOT",
  STOCK_LOCATION: "LOC",
  WORK_ORDER: "OF",
  PURCHASE_ORDER: "BCF",
  RECEPTION: "REC",
  QUALITY_CONTROL: "CQ",
  TOOL: "OUT",
  DELIVERY: "BL",
};

const READ_ROLE_NEEDLES: Readonly<Record<IdentificationEntityType, readonly string[]>> = {
  STOCK_ARTICLE: ["admin", "directeur", "stock", "logisti", "magasin", "production", "atelier", "program", "planif", "qualit", "method", "achat", "appro"],
  STOCK_LOT: ["admin", "directeur", "stock", "logisti", "magasin", "production", "atelier", "program", "planif", "qualit", "method", "achat", "appro"],
  STOCK_LOCATION: ["admin", "directeur", "stock", "logisti", "magasin", "production", "atelier", "program", "planif", "qualit", "method", "achat", "appro"],
  WORK_ORDER: ["admin", "directeur", "production", "atelier", "method", "planif", "program", "qualit", "logisti"],
  PURCHASE_ORDER: ["admin", "directeur", "secr", "achat", "logisti", "magasin", "compt", "qualit", "program", "planif", "commercial"],
  RECEPTION: ["admin", "directeur", "qualit", "achat", "appro", "stock", "logisti", "magasin"],
  QUALITY_CONTROL: ["admin", "directeur", "qualit", "quality", "qse", "metrolog", "production", "atelier"],
  TOOL: ["admin", "directeur", "production", "atelier", "method", "stock", "magasin", "operateur"],
  DELIVERY: ["admin", "directeur", "stock", "logisti", "magasin", "production", "atelier", "program", "planif", "secr", "qualit", "commercial"],
};

const MANAGE_ROLE_NEEDLES: Readonly<Record<IdentificationEntityType, readonly string[]>> = {
  STOCK_ARTICLE: ["admin", "directeur", "stock", "logisti", "magasin", "program", "method", "achat", "appro"],
  STOCK_LOT: ["admin", "directeur", "stock", "logisti", "magasin", "qualit"],
  STOCK_LOCATION: ["admin", "directeur", "stock", "logisti", "magasin"],
  WORK_ORDER: ["admin", "directeur", "production", "method", "program"],
  PURCHASE_ORDER: ["admin", "directeur", "secr", "achat", "program", "logisti"],
  RECEPTION: ["admin", "directeur", "qualit", "achat", "appro", "stock", "logisti", "magasin"],
  QUALITY_CONTROL: ["admin", "directeur", "qualit", "quality", "qse"],
  TOOL: ["admin", "directeur", "production", "method", "program"],
  DELIVERY: ["admin", "directeur", "stock", "logisti", "magasin", "qualit", "secr"],
};

function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
}

function hasNeedle(role: string | null | undefined, needles: readonly string[]): boolean {
  const normalized = fold(role ?? "");
  return normalized.length > 0 && needles.some((needle) => normalized.includes(fold(needle)));
}

export function buildIdentificationPayload(publicId: string): string {
  if (!new RegExp(`^${UUID}$`, "i").test(publicId)) throw new Error("INVALID_PUBLIC_ID");
  return `CERP:${IDENTIFICATION_CONTRACT_VERSION}:${publicId.toLowerCase()}`;
}

export function parseIdentificationPayload(raw: string): string {
  const match = PAYLOAD_RE.exec(raw.trim());
  if (!match?.[1]) {
    throw new HttpError(422, "IDENTIFICATION_INVALID_PAYLOAD", "Code non reconnu. Saisissez ou scannez un identifiant CERP version 1.");
  }
  return match[1].toLowerCase();
}

export function assertFlowAcceptsEntity(flow: IdentificationFlow, entityType: IdentificationEntityType): void {
  if (!FLOW_ENTITY_TYPES[flow].includes(entityType)) {
    throw new HttpError(422, "IDENTIFICATION_WRONG_ENTITY_TYPE", `Le flux ${flow} n'accepte pas une entité ${entityType}.`);
  }
}

export function entityModule(entityType: IdentificationEntityType): string {
  return ENTITY_MODULE[entityType];
}

export function roleCanReadEntity(role: string | null | undefined, entityType: IdentificationEntityType): boolean {
  return hasNeedle(role, READ_ROLE_NEEDLES[entityType]);
}

export function roleCanManageEntity(role: string | null | undefined, entityType: IdentificationEntityType): boolean {
  return hasNeedle(role, MANAGE_ROLE_NEEDLES[entityType]);
}

export function buildHumanCode(entityType: IdentificationEntityType, canonicalCode: string): string {
  const normalized = canonicalCode.trim().replace(/\s+/g, " ");
  if (!normalized) throw new Error("EMPTY_CANONICAL_CODE");
  return `${ENTITY_PREFIX[entityType]}-${normalized}`.slice(0, 160);
}

export function targetRoute(entityType: IdentificationEntityType, entityId: string): string {
  const id = encodeURIComponent(entityId);
  switch (entityType) {
    case "STOCK_ARTICLE": return `/stock/articles/${id}`;
    case "STOCK_LOT": return `/stock/lots?lot=${id}`;
    case "STOCK_LOCATION": return `/stock/magasins?emplacement=${id}`;
    case "WORK_ORDER": return `/production/of/${id}`;
    case "PURCHASE_ORDER": return `/commandes-fournisseurs/${id}`;
    case "RECEPTION": return `/receptions/${id}`;
    case "QUALITY_CONTROL": return `/qualite/controles/${id}`;
    case "TOOL": return `/outils/${id}`;
    case "DELIVERY": return `/livraisons/${id}`;
  }
}

export function forbiddenStatusReason(entityType: IdentificationEntityType, status: string | null, flow: IdentificationFlow): string | null {
  const normalized = fold(status ?? "").replace(/\s+/g, "_").toUpperCase();
  if (["ANNULE", "ANNULEE", "CANCELLED", "ARCHIVED", "ARCHIVE", "INACTIVE"].includes(normalized)) return `Statut ${status ?? "inconnu"}`;
  if (entityType === "STOCK_LOT" && ["CONSUME", "SHIP"].includes(flow) && ["BLOQUE", "QUARANTAINE", "EN_ATTENTE"].includes(normalized)) return `Lot ${status}`;
  if (entityType === "WORK_ORDER" && flow === "START_WORK_ORDER" && ["CLOTURE", "TERMINE", "ANNULE"].includes(normalized)) return `OF ${status}`;
  if (entityType === "DELIVERY" && flow === "SHIP" && normalized !== "READY") return `Livraison ${status ?? "sans statut"}`;
  return null;
}

export function validateClientScanTimestamp(value: Date, now = new Date()): "OK" | "STALE_OFFLINE_EVENT" | "FUTURE_TIMESTAMP" {
  const ageMs = now.getTime() - value.getTime();
  if (ageMs < -5 * 60_000) return "FUTURE_TIMESTAMP";
  if (ageMs > 7 * 24 * 60 * 60_000) return "STALE_OFFLINE_EVENT";
  return "OK";
}

export function scanReplayIdentityMatches(
  stored: { actor_user_id: number; payload_sha256: string; flow: string; source: string; client_scanned_at: string; expected_entity_types: readonly string[]; device_id: string | null },
  attempted: { actor_user_id: number; payload_sha256: string; flow: string; source: string; client_scanned_at: string; expected_entity_types: readonly string[]; device_id?: string },
): boolean {
  const storedTimestamp = Date.parse(stored.client_scanned_at)
  const attemptedTimestamp = Date.parse(attempted.client_scanned_at)
  return stored.actor_user_id === attempted.actor_user_id
    && stored.payload_sha256 === attempted.payload_sha256
    && stored.flow === attempted.flow
    && stored.source === attempted.source
    && Number.isFinite(storedTimestamp)
    && storedTimestamp === attemptedTimestamp
    && stored.device_id === (attempted.device_id ?? null)
    && stored.expected_entity_types.length === attempted.expected_entity_types.length
    && stored.expected_entity_types.every((value, index) => value === attempted.expected_entity_types[index])
}

export const IDENTIFICATION_HARDWARE_POLICY = {
  QR_CODE: { min_module_mm: 0.5, use: "caméra ou lecteur 2D, distance courte" },
  CODE_128: { min_x_dimension_mm: 0.33, use: "douchette laser/CCD ou clavier, étiquette linéaire" },
  DATA_MATRIX: { min_module_mm: 0.4, use: "petite étiquette durable, lecteur 2D requis" },
} as const;
