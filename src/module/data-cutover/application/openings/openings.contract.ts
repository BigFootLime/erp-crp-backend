import type { PoolClient } from "pg";
import { HttpError } from "../../../../utils/httpError";
import { repoCreateHistoricalImportTx, resolveUnitIdForArticle, type AuditContext } from "../../../stock/repository/stock.repository";
import { historicalImportSchema, type HistoricalImportBodyDTO } from "../../../stock/validators/stock.validators";
import type { CutoverRow } from "../../types/data-cutover.types";
import { createFinanceOpeningBalanceTx, createUnbilledLegacyDocumentStateTx, createWipOpeningStateTx } from "./openings.repository";
import { resumeNativeWipPreparationTx } from "./wip-native.adapter";

export type CutoverTarget = { id: string; reference: string | null; type: string };
export type CutoverTargets = Map<string, CutoverTarget>;
export type OpeningEffect = { type: "STOCK_MOVEMENT" | "WIP_OPENING" | "ORDRE_FABRICATION" | "FINANCE_OPENING" | "UNBILLED_LEGACY_DOCUMENT"; id: string };
export type OpeningTarget = { rowId: string; domain: CutoverRow["domain"]; targetType: string; targetId: string; targetReference: string };

const keyFor = (row: CutoverRow) => `${row.domain}:${row.legacy_key}`;
const text = (row: CutoverRow, field: string): string | null => {
  const value = row.values[field];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};
const decimal = (row: CutoverRow, field: string): string | null => {
  const value = row.values[field];
  const valueText = typeof value === "number" || typeof value === "string" ? String(value).trim().replace(",", ".") : "";
  return /^-?\d+(?:\.\d{1,6})?$/.test(valueText) ? valueText : null;
};
const isZero = (value: string | null) => value === null || /^0+(?:\.0+)?$/.test(value);
const present = (value: unknown) => value !== null && value !== undefined && (typeof value !== "string" || value.trim() !== "");
function resolvedTarget(targets: CutoverTargets, row: CutoverRow, input: { explicitField: string; domain: string; legacyField?: string; expectedType: string | string[] }) {
  const expected = Array.isArray(input.expectedType) ? input.expectedType : [input.expectedType];
  const explicitId = text(row, input.explicitField);
  if (explicitId) {
    const matches = [...targets.values()].filter((target) => target.id === explicitId && expected.includes(target.type));
    const unique = [...new Map(matches.map((target) => [`${target.type}:${target.id}`, target])).values()];
    if (unique.length === 1) return unique[0];
    return null;
  }
  const legacy = input.legacyField ? text(row, input.legacyField) : null;
  const candidate = targets.get(`${input.domain}:${legacy ?? row.legacy_key}`);
  if (candidate && expected.includes(candidate.type)) return candidate;
  return null;
}

export function assertOpeningRowsReady(rows: CutoverRow[], allowed: CutoverRow["domain"][]) {
  for (const row of rows) {
    if (!allowed.includes(row.domain)) throw new HttpError(422, "CUTOVER_OPENING_DOMAIN_INVALID", "Cette fiche ne correspond pas à une ouverture autorisée.");
    if (row.decision !== "INCLUDE" || row.status !== "READY") {
      throw new HttpError(409, "CUTOVER_OPENING_ROW_NOT_READY", "Chaque fiche retenue doit être validée et sans anomalie avant son application.");
    }
  }
}

/** Shared, side-effect-free checks for the preview and the native write. */
export function assertOpeningStockInputs(row: CutoverRow) {
  if (row.values.stockScope !== "OLD") throw new HttpError(422, "CUTOVER_OPENING_SCOPE_INVALID", "Une reprise de stock doit rester dans le périmètre OLD.");
  const quantity = decimal(row, "quantityCounted");
  if (!quantity || Number(quantity) <= 0 || !text(row, "unit")) throw new HttpError(422, "CUTOVER_STOCK_QUANTITY_REQUIRED", "Confirmer une quantité physique strictement positive et son unité. Un stock compté à zéro reste dans les archives, hors du chargement.");
  if (!isZero(decimal(row, "quantityReserved"))) throw new HttpError(422, "CUTOVER_STOCK_RESERVATION_TARGET_REQUIRED", "Une quantité réservée exige d'abord son affaire ou sa commande CERP cible.");
  if (present(row.values.valuationUnitPrice)) throw new HttpError(422, "CUTOVER_STOCK_VALUE_BASIS_REQUIRED", "La valeur d'ouverture nécessite une base CUMP justifiée.");
  if (!text(row, "supplierLot") && !text(row, "lotReference")) throw new HttpError(422, "CUTOVER_STOCK_LOT_REQUIRED", "Confirmer le lot d'origine avant la reprise du stock.");
  const warehouse = text(row, "warehouse"), location = text(row, "location");
  if (!warehouse || !location) throw new HttpError(422, "CUTOVER_STOCK_LOCATION_REQUIRED", "Confirmer le magasin et l'emplacement source avant la reprise.");
  if (`${warehouse}/${location}`.length > 120) throw new HttpError(422, "CUTOVER_STOCK_LOCATION_TOO_LONG", "Le magasin et l'emplacement regroupés doivent tenir dans 120 caractères pour conserver l'emplacement historique natif.");
}

/**
 * A finished OLD lot must name its real technical version.  Current/applicable
 * version is intentionally not a fallback: an historical quantity can belong
 * to an older index while a newer one is already applicable.
 */
export async function resolveOpeningPfTechnicalVersionTx(client: PoolClient, row: CutoverRow, articleId: string): Promise<string> {
  const planReference = text(row, "planReference");
  const externalRevision = text(row, "externalRevision");
  const withoutRevision = row.values.withoutRevision === true;
  const unit = text(row, "unit");
  if (!planReference || !unit || (!externalRevision && !withoutRevision) || (externalRevision && withoutRevision)) {
    throw new HttpError(422, "CUTOVER_STOCK_PF_REVISION_REQUIRED", "Confirmer la référence du plan et son indice, ou confirmer explicitement l'absence d'indice, avant la reprise PF.");
  }
  const versions = await client.query<{ id: string }>(
    `SELECT version.id::text AS id
     FROM public.articles article
     JOIN public.piece_technique_versions version ON version.piece_technique_id=article.piece_technique_id
     WHERE article.id=$1::uuid
       AND version.plan_reference=$2
       AND (CASE WHEN $3::boolean
             THEN version.indice_externe_original IS NULL AND version.indice='NA'
             ELSE version.indice_externe_original=$4 END)
     FOR SHARE OF article, version`,
    [articleId, planReference, withoutRevision, externalRevision]
  );
  if (versions.rows.length !== 1) {
    throw new HttpError(422, "CUTOVER_STOCK_PF_VERSION_UNRESOLVED", "La référence de plan et l'indice ne désignent pas une version technique unique de l'article. Corriger le rapprochement avant toute écriture de stock.");
  }
  const sourceUnitId = await resolveUnitIdForArticle(client, articleId, unit);
  const articleUnitId = await resolveUnitIdForArticle(client, articleId, null);
  if (sourceUnitId !== articleUnitId) {
    throw new HttpError(422, "PF_ARTICLE_UNIT_MISMATCH", "L'unité du stock historique ne correspond pas à l'unité de l'article fini.");
  }
  return versions.rows[0].id;
}

/**
 * Stock OLD is deliberately restrictive. A real movement is only posted when
 * the existing native writer can preserve every supplied business fact. Cases
 * needing a source location, third-party ownership, a reservation or a value
 * basis stay blocked instead of silently degrading into a generic OLD shelf.
 */
export async function applyOpeningStockTx(params: {
  client: PoolClient;
  rows: CutoverRow[];
  targets: CutoverTargets;
  audit: AuditContext;
  idempotencyKeyFor(row: CutoverRow): string;
}): Promise<{ targets: OpeningTarget[]; effects: OpeningEffect[] }> {
  assertOpeningRowsReady(params.rows, ["OPENING_STOCK"]);
  const targets: OpeningTarget[] = [], effects: OpeningEffect[] = [];
  for (const row of params.rows) {
    assertOpeningStockInputs(row);
    const target = resolvedTarget(params.targets, row, { explicitField: "articleTargetId", domain: "ARTICLE", legacyField: "articleLegacyKey", expectedType: "ARTICLE" }) ?? params.targets.get(keyFor(row));
    if (!target || target.type !== "ARTICLE") throw new HttpError(422, "CUTOVER_STOCK_ARTICLE_UNRESOLVED", "Rapprocher explicitement l'article CERP avant la reprise du stock.");
    const quantity = decimal(row, "quantityCounted");
    const unit = text(row, "unit");
    if (!quantity || Number(quantity) <= 0 || !unit) throw new HttpError(422, "CUTOVER_STOCK_QUANTITY_REQUIRED", "Confirmer la quantité physique strictement positive et son unité avant la reprise.");
    let ownerClientId: string | null = null;
    if (row.values.owner === "CLIENT") {
      const ownerCode = text(row, "ownerCode");
      const owner = resolvedTarget(params.targets, row, { explicitField: "ownerTargetId", domain: "CUSTOMER", legacyField: "ownerLegacyKey", expectedType: "CUSTOMER" })
        ?? (ownerCode ? params.targets.get(`CUSTOMER:${ownerCode}`) : null);
      if (!owner) throw new HttpError(422, "CUTOVER_STOCK_OWNER_UNRESOLVED", "Rapprocher explicitement le client propriétaire avant toute écriture de stock.");
      ownerClientId = owner.id;
    } else if (row.values.owner !== "CRP") {
      throw new HttpError(422, "CUTOVER_STOCK_OWNER_UNSUPPORTED", "Le stock fournisseur doit être qualifié dans le flux d'achat avant toute écriture de stock.");
    }
    if (!isZero(decimal(row, "quantityReserved"))) throw new HttpError(422, "CUTOVER_STOCK_RESERVATION_TARGET_REQUIRED", "Une quantité réservée exige d'abord son affaire ou sa commande CERP cible.");
    if (present(row.values.valuationUnitPrice)) throw new HttpError(422, "CUTOVER_STOCK_VALUE_BASIS_REQUIRED", "La valeur d'ouverture doit être déclarée via une base CUMP justifiée, sans l'écrire directement dans le mouvement de stock.");
    const kind = row.values.stockKind;
    const lotReference = text(row, "supplierLot") ?? text(row, "lotReference");
    if (!lotReference) throw new HttpError(422, "CUTOVER_STOCK_LOT_REQUIRED", "Confirmer le lot d'origine avant la reprise matière.");
    const sourceWarehouse = text(row, "warehouse");
    const sourceLocation = text(row, "location");
    if (!sourceWarehouse || !sourceLocation) throw new HttpError(422, "CUTOVER_STOCK_LOCATION_REQUIRED", "Confirmer le magasin et l'emplacement source avant la reprise.");
    const common = { article_id: target.id, quantity: Number(quantity), historical_lot_reference: text(row, "lotReference"), supplier_lot_code: text(row, "supplierLot"),
      historical_shelf: `${sourceWarehouse}/${sourceLocation}`, historical_lot_status: String(row.values.qualityStatus) as "LIBERE" | "QUARANTAINE" | "BLOQUE",
      owner_client_id: ownerClientId, notes: `Reprise OLD ${row.legacy_key}; justificatif ${text(row, "countEvidence") ?? "non renseigné"}`,
      historical_traceability: {
        ...(text(row, "certificateReference") ? { certificate_reference: text(row, "certificateReference")! } : {}),
        ...(text(row, "heatNumber") ? { heat_number: text(row, "heatNumber")! } : {}),
        source: { legacy_key: row.legacy_key, source_id: row.source_id, sheet: row.sheet, row_number: row.row_number },
      } };
    let body: HistoricalImportBodyDTO;
    if (kind === "MP") body = { kind: "MP", ...common, unite: unit, lot_number: lotReference };
    else if (kind === "PF") {
      const customer = resolvedTarget(params.targets, row, { explicitField: "customerTargetId", domain: "CUSTOMER", legacyField: "customerCode", expectedType: "CUSTOMER" });
      if (!customer) throw new HttpError(422, "CUTOVER_STOCK_PF_CUSTOMER_REQUIRED", "Rapprocher le client CERP de la pièce finie avant l'ouverture du stock.");
      const identity = (await params.client.query<{ client_id: string; client_code: string }>(`SELECT pt.client_id,COALESCE(NULLIF(pt.code_client,''),c.client_code,pt.client_id) AS client_code FROM public.articles a JOIN public.pieces_techniques pt ON pt.id=a.piece_technique_id JOIN public.clients c ON c.client_id=pt.client_id WHERE a.id=$1::uuid FOR SHARE OF pt,c`, [target.id])).rows[0];
      if (!identity || identity.client_id !== customer.id) throw new HttpError(422, "CUTOVER_STOCK_PF_CLIENT_MISMATCH", "La pièce technique et le client CERP rapproché ne correspondent pas. Vérifier le rapprochement avant l'ouverture du stock.");
      const technicalVersionId = await resolveOpeningPfTechnicalVersionTx(params.client, row, target.id);
      body = { kind: "PF", ...common, client_number: identity.client_code, technical_version_id: technicalVersionId, unite: unit, of_affaire_refs: [], mp_lot_refs: [], traitement_lot_refs: [] };
    } else throw new HttpError(422, "CUTOVER_STOCK_KIND_INVALID", "Choisir une nature de stock PF ou MP.");
    const validatedBody = historicalImportSchema.parse({ body }).body;
    const result = await repoCreateHistoricalImportTx(params.client, validatedBody, params.audit, params.idempotencyKeyFor(row));
    targets.push({ rowId: row.id, domain: row.domain, targetType: "STOCK_LOT", targetId: result.lot_id, targetReference: result.lot_code });
    effects.push({ type: "STOCK_MOVEMENT", id: result.movement_id });
  }
  return { targets, effects };
}

export type WipOpeningWriterTx = {
  createOpeningState(tx: PoolClient, input: {
    row: CutoverRow; article: CutoverTarget; affair: CutoverTarget; actorId: number;
  }): Promise<{ id: string; reference: string }>;
};
export async function applyWipOpeningTx(params: { client: PoolClient; rows: CutoverRow[]; targets: CutoverTargets; actorId: number; sourceSystem?: string; operationKey?: string; writer?: WipOpeningWriterTx }) {
  assertOpeningRowsReady(params.rows, ["WIP"]);
  const targets: OpeningTarget[] = [], effects: OpeningEffect[] = [];
  for (const row of params.rows) {
    if (!text(row, "workshopValidator") || !text(row, "evidenceReference")) throw new HttpError(422, "CUTOVER_WIP_EVIDENCE_REQUIRED", "L'état d'encours doit être confirmé par l'atelier avec son justificatif.");
    const article = resolvedTarget(params.targets, row, { explicitField: "articleTargetId", domain: "ARTICLE", legacyField: "articleLegacyKey", expectedType: "ARTICLE" });
    const affairTypes = ["SALES_ORDER", "INTERNAL_DEMAND", "COMMANDE_CLIENT", "BESOIN_INTERNE"];
    const affair = resolvedTarget(params.targets, row, { explicitField: "affairTargetId", domain: "SALES_ORDER", legacyField: "affairLegacyKey", expectedType: affairTypes })
      ?? resolvedTarget(params.targets, row, { explicitField: "affairTargetId", domain: "INTERNAL_DEMAND", legacyField: "affairLegacyKey", expectedType: affairTypes });
    if (!article || !affair) throw new HttpError(422, "CUTOVER_WIP_TARGET_UNRESOLVED", "Rapprocher l'article et l'affaire CERP avant de créer l'état d'encours.");
    const opening = await (params.writer?.createOpeningState ?? createWipOpeningStateTx)(params.client, { row, article, affair, actorId: params.actorId });
    if (row.values.resumeMode === "NATIVE_RESUME") {
      const native = await resumeNativeWipPreparationTx(params.client, {
        row, article, affair, actorId: params.actorId, openingStateId: opening.id,
        sourceSystem: params.sourceSystem ?? "CLIPPER_EXCEL", operationKey: params.operationKey ?? `${row.batch_id}:${row.id}`,
      });
      targets.push({ rowId: row.id, domain: row.domain, targetType: "ORDRE_FABRICATION", targetId: String(native.ofId), targetReference: native.ofReference });
      effects.push({ type: "ORDRE_FABRICATION", id: String(native.ofId) });
    } else targets.push({ rowId: row.id, domain: row.domain, targetType: "WIP_OPENING", targetId: opening.id, targetReference: opening.reference });
    effects.push({ type: "WIP_OPENING", id: opening.id });
  }
  return { targets, effects };
}

export type FinanceOpeningWriterTx = {
  createBalance(tx: PoolClient, input: { row: CutoverRow; partner: CutoverTarget; actorId: number }): Promise<{ id: string; reference: string }>;
  createUnbilledLegacyDocument(tx: PoolClient, input: { row: CutoverRow; partner: CutoverTarget; article: CutoverTarget; actorId: number }): Promise<{ id: string; reference: string }>;
};
export async function applyFinanceOpeningsTx(params: { client: PoolClient; rows: CutoverRow[]; targets: CutoverTargets; actorId: number; writer?: FinanceOpeningWriterTx }) {
  assertOpeningRowsReady(params.rows, ["OPENING_RECEIVABLE", "OPENING_PAYABLE", "LEGACY_DELIVERY", "LEGACY_RECEIPT"]);
  const targets: OpeningTarget[] = [], effects: OpeningEffect[] = [];
  for (const row of params.rows) {
    if (row.domain === "OPENING_RECEIVABLE" || row.domain === "OPENING_PAYABLE") {
      const partner = resolvedTarget(params.targets, row, { explicitField: "partnerTargetId", domain: row.domain === "OPENING_RECEIVABLE" ? "CUSTOMER" : "SUPPLIER", legacyField: "partnerLegacyKey", expectedType: row.domain === "OPENING_RECEIVABLE" ? "CUSTOMER" : "SUPPLIER" });
      if (!partner) throw new HttpError(422, "CUTOVER_FINANCE_PARTNER_UNRESOLVED", "Rapprocher explicitement le partenaire CERP avant la reprise du solde.");
      const opening = await (params.writer?.createBalance ?? createFinanceOpeningBalanceTx)(params.client, { row, partner, actorId: params.actorId });
      targets.push({ rowId: row.id, domain: row.domain, targetType: "FINANCE_OPENING", targetId: opening.id, targetReference: opening.reference });
      effects.push({ type: "FINANCE_OPENING", id: opening.id });
      continue;
    }
    const partner = resolvedTarget(params.targets, row, { explicitField: "partnerTargetId", domain: row.domain === "LEGACY_DELIVERY" ? "CUSTOMER" : "SUPPLIER", legacyField: "partnerLegacyKey", expectedType: row.domain === "LEGACY_DELIVERY" ? "CUSTOMER" : "SUPPLIER" });
    const article = resolvedTarget(params.targets, row, { explicitField: "articleTargetId", domain: "ARTICLE", legacyField: "articleLegacyKey", expectedType: "ARTICLE" });
    if (!partner || !article) throw new HttpError(422, "CUTOVER_UNBILLED_TARGET_UNRESOLVED", "Rapprocher le partenaire et l'article CERP avant la reprise de ce livré ou reçu non facturé.");
    const legacy = await (params.writer?.createUnbilledLegacyDocument ?? createUnbilledLegacyDocumentStateTx)(params.client, { row, partner, article, actorId: params.actorId });
    targets.push({ rowId: row.id, domain: row.domain, targetType: "UNBILLED_LEGACY_DOCUMENT", targetId: legacy.id, targetReference: legacy.reference });
    effects.push({ type: "UNBILLED_LEGACY_DOCUMENT", id: legacy.id });
  }
  return { targets, effects };
}
