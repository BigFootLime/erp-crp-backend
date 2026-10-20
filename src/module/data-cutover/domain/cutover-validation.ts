import { createHash } from "node:crypto";
import { catalogFor } from "./cutover-catalog";
import { canonicalizeStockUnitCode } from "../../../shared/stock-unit";
import type { CutoverDomain, CutoverIssue, CutoverRow, CutoverSummary, CutoverValues, Scalar } from "../types/data-cutover.types";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
export const hashCutover = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const missing = (v: Scalar | undefined) => v === undefined || v === null || (typeof v === "string" && !v.trim());
const quantityKeys = new Set(["quantityOrdered", "quantityDelivered", "quantityReceived", "quantityCancelled", "quantityRemaining", "quantityCompleted", "stockReserved", "quantityReserved", "quantityCounted", "scrapQuantity", "quantity", "paidAmount"]);

function decimal(value: Scalar | undefined, precision = 6): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim().replace(",", ".");
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  if (fraction.length > precision || whole.length > 12) return null;
  const scaled = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  return text.startsWith("-") ? -scaled : scaled;
}

export type CutoverValidationContext = { allowedUnits?: string[] };
export function validateCutoverValues(domain: CutoverDomain, values: CutoverValues, sourceIssues: string[] = [], reviewNote = "", context: CutoverValidationContext = {}): CutoverIssue[] {
  const issues: CutoverIssue[] = [];
  const add = (field: string | null, code: string, message: string) => issues.push({ field, code, message });
  const fields = catalogFor(domain).fields;
  const known = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(values)) if (!known.has(key)) add(key, "UNKNOWN_FIELD", "Ce champ n'appartient pas à cette fiche de reprise.");
  for (const field of fields) {
    const value = values[field.key];
    const required = field.required_when ? field.required_when.every((condition) => values[condition.field] === condition.value) : field.required;
    if (missing(value)) {
      if (required) add(field.key, "REQUIRED", `${field.label} : à compléter.`);
      continue;
    }
    if (field.type === "number") {
      const n = decimal(value, field.precision ?? 6);
      if (n === null) add(field.key, "INVALID_DECIMAL", `${field.label} : nombre attendu, sans arrondi automatique (${field.precision ?? 6} décimales maximum).`);
      else if (quantityKeys.has(field.key) && n < 0n) add(field.key, "NEGATIVE_QUANTITY", `${field.label} ne peut pas être négatif.`);
      else if (field.min !== undefined && n < decimal(field.min)!) add(field.key, "BELOW_MINIMUM", `${field.label} : valeur inférieure au minimum autorisé.`);
      else if (field.max !== undefined && n > decimal(field.max)!) add(field.key, "ABOVE_MAXIMUM", `${field.label} : valeur supérieure au maximum autorisé.`);
      if (n !== null && decimal(String(Number(String(value).trim().replace(",", "."))), field.precision ?? 6) !== n) add(field.key, "UNSAFE_DECIMAL", `${field.label} : cette valeur perdrait des décimales dans le parcours natif. La faire vérifier ; aucun arrondi automatique n'est autorisé.`);
      if (field.key === "vatRate" && n !== null && (n < 0n || n > 100_000_000n)) add(field.key, "INVALID_TAX_RATE", "La TVA doit être comprise entre 0 et 100 %.");
    } else if (field.type === "boolean" && typeof value !== "boolean") add(field.key, "INVALID_BOOLEAN", `${field.label} : choisir Oui ou Non.`);
    else if (field.type === "select" && (typeof value !== "string" || !field.options?.includes(value))) add(field.key, "INVALID_CHOICE", `${field.label} : choisir une valeur proposée.`);
    else if (field.type === "date") {
      const s = typeof value === "string" ? value : "";
      const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : null;
      if (!d || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) add(field.key, "INVALID_DATE", `${field.label} : date réelle attendue au format AAAA-MM-JJ.`);
    } else if (field.type === "text" && typeof value !== "string") add(field.key, "INVALID_TEXT", `${field.label} : texte attendu. Les références conservent leurs zéros initiaux.`);
    if (typeof value === "string") {
      if (field.max_length !== undefined && value.length > field.max_length) add(field.key, "TEXT_TOO_LONG", `${field.label} : ${field.max_length} caractères maximum.`);
      if (field.pattern && !new RegExp(field.pattern, "u").test(value)) add(field.key, "INVALID_TEXT_FORMAT", `${field.label} : texte attendu, sans balise ni caractère de contrôle.`);
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) add(field.key, "INVALID_EMAIL", "Saisir une adresse email valide.");
      if (field.format === "siret" && !/^\d{14}$/.test(value)) add(field.key, "INVALID_SIRET", "Un SIRET comporte exactement 14 chiffres. Ne pas remplacer une donnée inconnue par un numéro inventé.");
      if (field.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) add(field.key, "INVALID_TARGET", "Sélectionner une fiche CERP dans la recherche proposée.");
      if (field.format === "unit" && context.allowedUnits && !context.allowedUnits.includes(canonicalizeStockUnitCode(value) ?? "")) add(field.key, "UNKNOWN_STOCK_UNIT", "Choisir une unité existante dans le référentiel CERP. La création d'une unité se fait séparément.");
    }
    if (typeof value === "string" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) add(field.key, "CONTROL_CHARACTER", "Le texte contient un caractère de contrôle interdit.");
  }
  if (values.currency && !/^[A-Z]{3}$/.test(String(values.currency))) add("currency", "INVALID_CURRENCY", "Confirmer une devise ISO à trois lettres, par exemple EUR.");
  if (values.resolution === "LINK" && missing(values.targetId)) add("targetId", "TARGET_REQUIRED", "Sélectionner explicitement le compte CERP à rapprocher.");
  if (domain === "ARTICLE" && values.resolution !== "LINK" && values.category === "fabrique" && missing(values.technicalPieceId) && missing(values.technicalPieceLegacyKey)) add("technicalPieceId", "TECHNICAL_PIECE_REQUIRED", "Un article fabriqué doit être relié à sa pièce technique CERP ou à sa fiche de reprise identifiée.");
  if ((domain === "TECHNICAL_PIECE" || (domain === "OPENING_STOCK" && values.stockKind === "PF")) && values.resolution !== "LINK" && missing(values.externalRevision) && values.withoutRevision !== true) add("externalRevision", "REVISION_REQUIRED", "Préciser l'indice ou confirmer explicitement un plan sans indice.");
  if (!missing(values.externalRevision) && values.withoutRevision === true) add("externalRevision", "REVISION_CONTRADICTION", "Un plan ne peut pas avoir un indice et être déclaré sans indice en même temps.");
  if (!missing(values.externalRevision) && missing(values.planReference)) add("planReference", "PLAN_REFERENCE_REQUIRED", "Confirmer la référence du plan séparément de son indice.");
  if (domain === "OPENING_STOCK") {
    if (values.owner && values.owner !== "CRP" && missing(values.ownerCode)) add("ownerCode", "OWNER_REQUIRED", "Identifier le propriétaire tiers du stock.");
    if (values.owner === "CLIENT" && missing(values.ownerTargetId) && missing(values.ownerLegacyKey)) add("ownerTargetId", "OWNER_TARGET_REQUIRED", "Rapprocher le client propriétaire CERP avant l'ouverture du stock.");
    const qty = decimal(values.quantityCounted), reserved = decimal(values.quantityReserved);
    if (qty !== null && reserved !== null && reserved > qty) add("quantityReserved", "RESERVATION_EXCEEDS_STOCK", "La quantité réservée dépasse le stock physique compté.");
  }
  if (domain === "SALES_ORDER") {
    if (!values.orderType || values.orderType === "UNKNOWN") add("orderType", "CONTRACT_TO_CONFIRM", "Contrat à confirmer : vérifier la commande et son éventuel contrat avant de choisir commande ponctuelle ou appel de contrat.");
    if (values.orderType === "CADRE_RELEASE" && missing(values.contractTargetId)) add("contractTargetId", "CONTRACT_TARGET_REQUIRED", "Un appel doit être rattaché à son contrat CERP explicitement confirmé.");
  }
  const remainingParts: Partial<Record<CutoverDomain, string>> = { SALES_ORDER: "quantityDelivered", SUPPLIER_ORDER: "quantityReceived", INTERNAL_DEMAND: "quantityCompleted" };
  const completedKey = remainingParts[domain];
  if (completedKey) {
    const ordered = decimal(values.quantityOrdered), done = decimal(values[completedKey]), remaining = decimal(values.quantityRemaining), cancelled = missing(values.quantityCancelled) ? 0n : decimal(values.quantityCancelled);
    if (ordered !== null && done !== null && remaining !== null && cancelled !== null && ordered - done - cancelled !== remaining) add("quantityRemaining", "REMAINING_MISMATCH", "Quantité initiale - réalisé - annulé doit correspondre au reliquat. Faire vérifier l'écart.");
    const reserved = decimal(values.stockReserved);
    if (remaining !== null && reserved !== null && reserved > remaining) add("stockReserved", "RESERVATION_EXCEEDS_REMAINING", "La réservation dépasse le reliquat de cette affaire.");
  }
  if (domain === "OPENING_RECEIVABLE" || domain === "OPENING_PAYABLE") {
    const keys = ["originalAmount", "paymentsAllocated", "creditsAllocated", "depositsAllocated", "openBalance"];
    const [original, paid, credits, deposits, balance] = keys.map((key) => decimal(values[key], 2));
    if ([original, paid, credits, deposits, balance].every((v) => v !== null) && original! - paid! - credits! - deposits! !== balance!) add("openBalance", "BALANCE_MISMATCH", "Le solde ne correspond pas au document diminué des règlements, avoirs et acomptes imputés.");
  }
  if ((domain === "LEGACY_DELIVERY" || domain === "LEGACY_RECEIPT") && values.billingStatus !== "FULLY_BILLED" && missing(values.unbilledAmount)) add("unbilledAmount", "UNBILLED_AMOUNT_REQUIRED", "Confirmer le montant restant à facturer avant reprise.");
  if (sourceIssues.length && !reviewNote.trim()) add(null, "SOURCE_EXCEPTION_REVIEW", "Une anomalie de la source demande une explication et une vérification documentée.");
  return issues;
}

export function inspectCutoverRow<T extends Omit<CutoverRow, "status" | "issues">>(row: T, context: CutoverValidationContext = {}): T & Pick<CutoverRow, "status" | "issues"> {
  const normalizedUnit = typeof row.values.unit === "string" ? canonicalizeStockUnitCode(row.values.unit) : null;
  const values = normalizedUnit && context.allowedUnits?.includes(normalizedUnit) ? { ...row.values, unit: normalizedUnit } : row.values;
  const issues = validateCutoverValues(row.domain, values, row.source_issues, row.review_note, context);
  if (row.decision === "INCLUDE" && ["SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND"].includes(row.domain) && decimal(values.quantityRemaining) === 0n) issues.push({ field: "quantityRemaining", code: "NO_OPEN_REMAINDER", message: "Ce dossier est soldé. Le conserver dans l'historique ou l'écarter du lot ; il ne doit pas créer une nouvelle commande CERP." });
  const status = row.decision === "EXCLUDE" ? "EXCLUDED" : row.decision === "PENDING" ? "UNDECIDED" : issues.length ? "MISSING" : "READY";
  return { ...row, values, status, issues };
}
export function summarizeCutover(rows: CutoverRow[]): CutoverSummary {
  return { total: rows.length, included: rows.filter((r) => r.decision === "INCLUDE").length, pending: rows.filter((r) => r.decision === "PENDING").length, excluded: rows.filter((r) => r.decision === "EXCLUDE").length, missing: rows.filter((r) => r.status === "MISSING").length, ready: rows.filter((r) => r.status === "READY").length };
}
export function requiredChecklist(rows: CutoverRow[]): string[] {
  const domains = new Set(rows.filter((r) => r.decision === "INCLUDE").map((r) => r.domain));
  return ["sources_frozen", "exclusive_scope", "no_external_emissions", ...(domains.has("OPENING_STOCK") ? ["physical_stock_verified"] : []), ...(domains.has("WIP") ? ["wip_verified"] : []), ...([...domains].some((d) => ["OPENING_RECEIVABLE", "OPENING_PAYABLE", "LEGACY_DELIVERY", "LEGACY_RECEIPT", "LEGACY_PROFORMA"].includes(d)) ? ["accounting_reconciled"] : [])];
}

export function duplicateCutoverTargets(rows: CutoverRow[]): Array<CutoverIssue & { row_id: string }> {
  const groups = new Map<string, CutoverRow[]>();
  for (const row of rows.filter((item) => item.decision === "INCLUDE")) {
    let identity: string | null = null;
    if (row.domain === "ARTICLE" && missing(row.values.targetId) && !missing(row.values.articleReference)) identity = `ARTICLE:${String(row.values.articleReference).normalize("NFKC").trim().toUpperCase()}`;
    if (row.domain === "TECHNICAL_PIECE" && !missing(row.values.customerCode) && !missing(row.values.planReference)) identity = canonicalJson(["TECHNICAL_PIECE", row.values.customerCode, row.values.planReference, row.values.externalRevision ?? null, row.values.withoutRevision === true]);
    if (identity) groups.set(identity, [...(groups.get(identity) ?? []), row]);
  }
  return [...groups.values()].filter((items) => items.length > 1).flatMap((items) => items.map((row) => ({ row_id: row.id, field: row.domain === "ARTICLE" ? "articleReference" : "planReference", code: "DUPLICATE_TARGET_IDENTITY", message: "Plusieurs fiches retenues proposent la même identité cible. Choisir la fiche faisant foi ou rapprocher les références avant de valider le lot." })));
}
