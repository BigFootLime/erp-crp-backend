import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { CreateAuditLogBodyDTO } from "../../audit-logs/validators/audit-logs.validators";
import {
  PROCUREMENT_CONTRACT_VERSION,
  PROCUREMENT_TIMEZONE,
  anomalyKey,
  calendarDaysBetween,
  leadTimeVariabilityDays,
  normalizeReceiptQuantity,
  procurementPayloadHash,
  rejectionRatePct,
  roundMetric,
  supplierOtdPct,
  type ProcurementReliability,
} from "../domain/procurement-reliability";
import type {
  AnomalyActionBodyDTO,
  ProcurementOverviewQueryDTO,
  ProcurementPolicyBodyDTO,
  PromisedDateBodyDTO,
} from "../validators/procurement-reliability.validators";

type Queryer = Pick<PoolClient, "query">;

export type ProcurementActor = {
  user_id: number;
  role: string | null;
  ip: string | null;
  user_agent: string | null;
  path: string | null;
  page_key: string | null;
  client_session_id: string | null;
};

type ProcurementCommandAction = "ANOMALY_ACTION" | "PROMISED_DATE" | "POLICY_VERSION";

type LineRow = {
  line_id: string;
  order_id: string;
  order_code: string;
  order_status: string;
  supplier_id: string;
  supplier_code: string | null;
  supplier_name: string | null;
  article_id: string | null;
  article_code: string | null;
  article_name: string | null;
  family_code: string | null;
  designation: string;
  purchase_unit: string | null;
  stock_unit: string | null;
  conversion_factor: number | null;
  ordered_qty: number;
  cancelled_qty: number;
  promised_date: string;
  promised_date_source: "LINE" | "HEADER";
  sent_date: string | null;
  expected_documents: string[];
  quality_requirements: Array<{ type?: unknown; obligatoire?: unknown }>;
  updated_at: string;
  price_tolerance_pct: number | null;
  over_receipt_tolerance_pct: number;
  lead_grace_days: number;
  policy_source: string | null;
};

type ReceiptRow = {
  receipt_line_id: string;
  line_id: string;
  receipt_id: string;
  receipt_no: string;
  receipt_status: string;
  receipt_date: string;
  qty_received: number;
  receipt_unit: string | null;
  lot_id: string | null;
  lot_code: string | null;
  lot_status: string | null;
  inspection_id: string | null;
  inspection_status: string | null;
  inspection_decision: string | null;
  inspection_decided_at: string | null;
  document_types: string[];
  updated_at: string;
};

type PromiseEventRow = {
  id: string;
  line_id: string | null;
  previous_date: string | null;
  promised_date: string;
  reason_code: string;
  note: string | null;
  actor_user_id: number;
  actor_name: string | null;
  created_at: string;
};

type ActionRow = {
  anomaly_key: string;
  owner_user_id: number | null;
  owner_name: string | null;
  next_action: string;
  due_date: string;
  status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "DISMISSED";
  resolution_note: string | null;
  updated_at: string;
};

type NormalizedReceipt = ReceiptRow & {
  purchase_qty: number | null;
  normalization: "EXACT" | "CONVERTED" | "UNCONVERTIBLE";
};

type LineFact = {
  line: LineRow;
  receipts: NormalizedReceipt[];
  expected_qty: number;
  received_qty: number;
  completion_date: string | null;
  on_time: boolean;
  due: boolean;
  has_unconvertible_receipt: boolean;
  inspected_qty: number;
  rejected_qty: number;
  promise_versioned: boolean;
  promise_history: PromiseEventRow[];
};

type Metric = {
  value: number | null;
  definition: string;
  unit: string;
  period: { from: string; to: string; as_of: string };
  source: string[];
  freshness_at: string | null;
  reliability: ProcurementReliability;
  missing: string[];
  numerator?: number;
  denominator?: number;
};

type ProcurementAnomaly = {
  key: string;
  kind: string;
  severity: "P1" | "P2" | "P3";
  supplier_id: string;
  order_id: string;
  order_code: string;
  line_id: string;
  label: string;
  evidence: Record<string, unknown>;
  recommended_action: string;
  suggested_due_date: string;
  action: ActionRow | null;
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNonNegativeNumber(value: unknown, field: string): number {
  const parsed = numberOrNull(value);
  if (parsed === null || parsed < 0) {
    throw new HttpError(500, "PROCUREMENT_SOURCE_DATA_INVALID", `La donnée source ${field} est absente ou invalide.`);
  }
  return parsed;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function qualityRequirements(value: unknown): Array<{ type?: unknown; obligatoire?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { type?: unknown; obligatoire?: unknown } => item !== null && typeof item === "object");
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

async function ensureInstalled(queryer: Queryer = db): Promise<void> {
  const result = await queryer.query<{ installed: boolean }>(
    `SELECT to_regclass('public.procurement_promised_date_events') IS NOT NULL
         AND to_regclass('public.procurement_anomaly_actions') IS NOT NULL
         AND to_regclass('public.procurement_policy_versions') IS NOT NULL
         AND to_regclass('public.procurement_command_receipts') IS NOT NULL AS installed`,
  );
  if (!result.rows[0]?.installed) {
    throw new HttpError(503, "PROCUREMENT_RELIABILITY_NOT_INSTALLED", "Le patch SOL-18 doit être appliqué avant d'utiliser le pilotage achats.");
  }
}

async function insertAudit(
  tx: Queryer,
  actor: ProcurementActor,
  entry: { action: string; entity_type: string; entity_id: string; details: Record<string, unknown> },
) {
  const body: CreateAuditLogBodyDTO = {
    event_type: "ACTION",
    action: entry.action,
    page_key: actor.page_key,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    path: actor.path,
    client_session_id: actor.client_session_id,
    details: entry.details,
  };
  await repoInsertAuditLog({
    user_id: actor.user_id,
    body,
    ip: actor.ip,
    user_agent: actor.user_agent,
    device_type: null,
    os: null,
    browser: null,
    tx,
  });
}

async function inTransaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const value = await work(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readCommandReceipt<T>(
  tx: Queryer,
  action: ProcurementCommandAction,
  idempotencyKey: string,
  requestHash: string,
): Promise<T | null> {
  const result = await tx.query<{ request_hash: string; response_snapshot: T }>(
    `SELECT request_hash,response_snapshot FROM public.procurement_command_receipts
     WHERE action=$1 AND idempotency_key=$2 FOR SHARE`,
    [action, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) {
    throw new HttpError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "Cette clé d'idempotence a déjà été utilisée avec une demande différente.");
  }
  return { ...row.response_snapshot, idempotent_replay: true } as T;
}

async function saveCommandReceipt(
  tx: Queryer,
  action: ProcurementCommandAction,
  idempotencyKey: string,
  requestHash: string,
  actorUserId: number,
  response: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO public.procurement_command_receipts
       (action,idempotency_key,request_hash,actor_user_id,response_snapshot)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [action, idempotencyKey, requestHash, actorUserId, JSON.stringify(response)],
  );
}

async function loadLineRows(query: ProcurementOverviewQueryDTO, asOf: string): Promise<LineRow[]> {
  const values: unknown[] = [query.from, query.to, asOf];
  const where: string[] = [
    `COALESCE(l.date_promesse,cf.date_promesse) BETWEEN $1::date AND LEAST($2::date,$3::date)`,
    `l.statut_ligne='ACTIVE'`,
    `cf.statut NOT IN ('BROUILLON','A_VALIDER','APPROUVEE','ANNULEE')`,
  ];
  if (query.supplier_id) {
    values.push(query.supplier_id);
    where.push(`cf.fournisseur_id=$${values.length}::uuid`);
  }
  if (query.article_id) {
    values.push(query.article_id);
    where.push(`l.article_id=$${values.length}::uuid`);
  }
  if (query.family_code) {
    values.push(query.family_code);
    where.push(`a.family_code=$${values.length}`);
  }

  const result = await db.query<Record<string, unknown>>(
    `SELECT
       l.id::text AS line_id,cf.id::text AS order_id,cf.code AS order_code,cf.statut AS order_status,
       cf.fournisseur_id::text AS supplier_id,COALESCE(f.code,f.code_fournisseur) AS supplier_code,
       COALESCE(f.nom,f.raison_sociale) AS supplier_name,l.article_id::text AS article_id,
       a.code AS article_code,a.designation AS article_name,a.family_code,l.designation,
       l.unite AS purchase_unit,l.unite_stock AS stock_unit,l.coef_conversion::float8 AS conversion_factor,
       l.quantite::float8 AS ordered_qty,l.qty_annulee::float8 AS cancelled_qty,
       COALESCE(l.date_promesse,cf.date_promesse)::text AS promised_date,
       CASE WHEN l.date_promesse IS NOT NULL THEN 'LINE' ELSE 'HEADER' END AS promised_date_source,
       cf.date_envoi::date::text AS sent_date,l.documents_attendus,l.exigences_qualite,
       GREATEST(cf.updated_at,l.updated_at)::text AS updated_at,
       policy.price_tolerance_pct::float8,COALESCE(policy.over_receipt_tolerance_pct,0)::float8 AS over_receipt_tolerance_pct,
       COALESCE(policy.lead_grace_days,0)::int AS lead_grace_days,
       CASE WHEN policy.id IS NULL THEN NULL ELSE policy.scope_type || ':' || COALESCE(policy.scope_id,'COMPANY') || ':' || policy.valid_from::text END AS policy_source
     FROM public.commande_fournisseur_ligne l
     JOIN public.commande_fournisseur cf ON cf.id=l.commande_id
     JOIN public.fournisseurs f ON f.id=cf.fournisseur_id
     LEFT JOIN public.articles a ON a.id=l.article_id
     LEFT JOIN LATERAL (
       SELECT p.* FROM public.procurement_policy_versions p
       WHERE p.valid_from <= $3::date AND (
         (p.scope_type='ARTICLE' AND p.scope_id=l.article_id::text)
         OR (p.scope_type='SUPPLIER' AND p.scope_id=cf.fournisseur_id::text)
         OR (p.scope_type='FAMILY' AND p.scope_id=a.family_code)
         OR (p.scope_type='COMPANY' AND p.scope_id IS NULL)
       )
       ORDER BY CASE p.scope_type WHEN 'ARTICLE' THEN 1 WHEN 'SUPPLIER' THEN 2 WHEN 'FAMILY' THEN 3 ELSE 4 END,
                p.valid_from DESC
       LIMIT 1
     ) policy ON TRUE
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(l.date_promesse,cf.date_promesse),cf.code,l.position`,
    values,
  );

  return result.rows.map((row) => ({
    line_id: String(row.line_id),
    order_id: String(row.order_id),
    order_code: String(row.order_code),
    order_status: String(row.order_status),
    supplier_id: String(row.supplier_id),
    supplier_code: typeof row.supplier_code === "string" ? row.supplier_code : null,
    supplier_name: typeof row.supplier_name === "string" ? row.supplier_name : null,
    article_id: typeof row.article_id === "string" ? row.article_id : null,
    article_code: typeof row.article_code === "string" ? row.article_code : null,
    article_name: typeof row.article_name === "string" ? row.article_name : null,
    family_code: typeof row.family_code === "string" ? row.family_code : null,
    designation: String(row.designation),
    purchase_unit: typeof row.purchase_unit === "string" ? row.purchase_unit : null,
    stock_unit: typeof row.stock_unit === "string" ? row.stock_unit : null,
    conversion_factor: numberOrNull(row.conversion_factor),
    ordered_qty: requiredNonNegativeNumber(row.ordered_qty, "commande_fournisseur_ligne.quantite"),
    cancelled_qty: requiredNonNegativeNumber(row.cancelled_qty, "commande_fournisseur_ligne.qty_annulee"),
    promised_date: String(row.promised_date),
    promised_date_source: row.promised_date_source === "LINE" ? "LINE" : "HEADER",
    sent_date: typeof row.sent_date === "string" ? row.sent_date : null,
    expected_documents: stringArray(row.documents_attendus),
    quality_requirements: qualityRequirements(row.exigences_qualite),
    updated_at: String(row.updated_at),
    price_tolerance_pct: numberOrNull(row.price_tolerance_pct),
    over_receipt_tolerance_pct: requiredNonNegativeNumber(row.over_receipt_tolerance_pct, "procurement_policy_versions.over_receipt_tolerance_pct"),
    lead_grace_days: requiredNonNegativeNumber(row.lead_grace_days, "procurement_policy_versions.lead_grace_days"),
    policy_source: typeof row.policy_source === "string" ? row.policy_source : null,
  }));
}

async function loadReceiptRows(lineIds: string[], asOf: string): Promise<ReceiptRow[]> {
  if (lineIds.length === 0) return [];
  const result = await db.query<Record<string, unknown>>(
    `SELECT rl.id::text AS receipt_line_id,rl.commande_fournisseur_ligne_id::text AS line_id,
            r.id::text AS receipt_id,r.reception_no,r.status AS receipt_status,r.reception_date::text,
            rl.qty_received::float8,rl.unite AS receipt_unit,rl.lot_id::text AS lot_id,
            lot.lot_code,lot.lot_status,ins.id::text AS inspection_id,ins.status AS inspection_status,
            ins.decision AS inspection_decision,ins.decided_at::text AS inspection_decided_at,
            COALESCE(array_agg(DISTINCT doc.document_type) FILTER (WHERE doc.id IS NOT NULL),ARRAY[]::text[]) AS document_types,
            GREATEST(r.updated_at,rl.updated_at,COALESCE(ins.updated_at,'epoch'::timestamptz))::text AS updated_at
       FROM public.reception_fournisseur_lignes rl
       JOIN public.receptions_fournisseurs r ON r.id=rl.reception_id
       LEFT JOIN public.lots lot ON lot.id=rl.lot_id
       LEFT JOIN public.reception_incoming_inspections ins ON ins.reception_line_id=rl.id
       LEFT JOIN public.reception_fournisseur_documents doc
         ON doc.reception_id=r.id AND doc.removed_at IS NULL
        AND (doc.reception_line_id=rl.id OR doc.reception_line_id IS NULL)
      WHERE rl.commande_fournisseur_ligne_id=ANY($1::uuid[])
        AND r.reception_date <= $2::date
      GROUP BY rl.id,r.id,r.reception_no,r.status,r.reception_date,lot.lot_code,lot.lot_status,
               ins.id,ins.status,ins.decision,ins.decided_at,ins.updated_at
      ORDER BY r.reception_date,rl.id`,
    [lineIds, asOf],
  );
  return result.rows.map((row) => ({
    receipt_line_id: String(row.receipt_line_id),
    line_id: String(row.line_id),
    receipt_id: String(row.receipt_id),
    receipt_no: String(row.reception_no),
    receipt_status: String(row.receipt_status),
    receipt_date: String(row.reception_date),
    qty_received: requiredNonNegativeNumber(row.qty_received, "reception_fournisseur_lignes.qty_received"),
    receipt_unit: typeof row.receipt_unit === "string" ? row.receipt_unit : null,
    lot_id: typeof row.lot_id === "string" ? row.lot_id : null,
    lot_code: typeof row.lot_code === "string" ? row.lot_code : null,
    lot_status: typeof row.lot_status === "string" ? row.lot_status : null,
    inspection_id: typeof row.inspection_id === "string" ? row.inspection_id : null,
    inspection_status: typeof row.inspection_status === "string" ? row.inspection_status : null,
    inspection_decision: typeof row.inspection_decision === "string" ? row.inspection_decision : null,
    inspection_decided_at: typeof row.inspection_decided_at === "string" ? row.inspection_decided_at : null,
    document_types: stringArray(row.document_types),
    updated_at: String(row.updated_at),
  }));
}

async function loadPromiseHistory(lines: LineRow[]): Promise<Map<string, PromiseEventRow[]>> {
  if (lines.length === 0) return new Map();
  const result = await db.query<PromiseEventRow & { effective_line_id: string }>(
    `SELECT l.id::text AS effective_line_id,e.id::text,e.ligne_id::text,e.previous_date::text,
            e.promised_date::text,e.reason_code,e.note,e.actor_user_id,
            COALESCE(NULLIF(trim(concat_ws(' ',u.name,u.surname)),''),u.username) AS actor_name,
            e.created_at::text
       FROM public.commande_fournisseur_ligne l
       JOIN public.procurement_promised_date_events e
         ON e.commande_id=l.commande_id AND (e.ligne_id=l.id OR e.ligne_id IS NULL)
       LEFT JOIN public.users u ON u.id=e.actor_user_id
      WHERE l.id=ANY($1::uuid[])`,
    [lines.map((line) => line.line_id)],
  );
  const histories = new Map<string, PromiseEventRow[]>();
  for (const row of result.rows) {
    const history = histories.get(row.effective_line_id) ?? [];
    history.push({
      id: row.id,
      line_id: row.line_id,
      previous_date: row.previous_date,
      promised_date: row.promised_date,
      reason_code: row.reason_code,
      note: row.note,
      actor_user_id: row.actor_user_id,
      actor_name: row.actor_name,
      created_at: row.created_at,
    });
    histories.set(row.effective_line_id, history);
  }
  for (const history of histories.values()) history.sort((left, right) => left.created_at.localeCompare(right.created_at));
  return histories;
}

function buildFacts(lines: LineRow[], receipts: ReceiptRow[], promiseHistory: Map<string, PromiseEventRow[]>, asOf: string): LineFact[] {
  const linesById = new Map(lines.map((line) => [line.line_id, line]));
  const receiptsByLine = new Map<string, NormalizedReceipt[]>();
  for (const receipt of receipts) {
    if (receipt.receipt_status === "CANCELLED") continue;
    const sourceLine = linesById.get(receipt.line_id);
    const normalized = normalizeReceiptQuantity({
      receiptQty: receipt.qty_received,
      receiptUnit: receipt.receipt_unit,
      purchaseUnit: sourceLine?.purchase_unit ?? null,
      stockUnit: sourceLine?.stock_unit ?? null,
      stockUnitsPerPurchaseUnit: sourceLine?.conversion_factor ?? null,
    });
    const list = receiptsByLine.get(receipt.line_id) ?? [];
    list.push({ ...receipt, purchase_qty: normalized.purchaseQty, normalization: normalized.status });
    receiptsByLine.set(receipt.line_id, list);
  }

  return lines.map((line) => {
    const lineReceipts = (receiptsByLine.get(line.line_id) ?? []).sort((a, b) => a.receipt_date.localeCompare(b.receipt_date));
    const expectedQty = Math.max(0, line.ordered_qty - line.cancelled_qty);
    let cumulative = 0;
    let completionDate: string | null = null;
    for (const receipt of lineReceipts) {
      if (receipt.purchase_qty === null) continue;
      cumulative += receipt.purchase_qty;
      if (completionDate === null && cumulative + 1e-9 >= expectedQty) completionDate = receipt.receipt_date;
    }
    const decided = lineReceipts.filter((receipt) => receipt.inspection_status === "DECIDED" && receipt.purchase_qty !== null);
    const inspectedQty = decided.reduce((sum, receipt) => sum + (receipt.purchase_qty ?? 0), 0);
    const rejectedQty = decided
      .filter((receipt) => receipt.inspection_decision === "BLOQUE")
      .reduce((sum, receipt) => sum + (receipt.purchase_qty ?? 0), 0);
    return {
      line,
      receipts: lineReceipts,
      expected_qty: expectedQty,
      received_qty: roundMetric(cumulative, 6),
      completion_date: completionDate,
      on_time: completionDate !== null && completionDate <= line.promised_date,
      due: line.promised_date <= asOf,
      has_unconvertible_receipt: lineReceipts.some((receipt) => receipt.normalization === "UNCONVERTIBLE"),
      inspected_qty: roundMetric(inspectedQty, 6),
      rejected_qty: roundMetric(rejectedQty, 6),
      promise_versioned: (promiseHistory.get(line.line_id)?.length ?? 0) > 0,
      promise_history: promiseHistory.get(line.line_id) ?? [],
    };
  });
}

function metricSet(facts: LineFact[], period: Metric["period"], includePrices: boolean): Record<string, Metric> {
  const due = facts.filter((fact) => fact.due && !fact.has_unconvertible_receipt);
  const onTime = due.filter((fact) => fact.on_time).length;
  const leadTimes = facts.flatMap((fact) => {
    if (!fact.completion_date || !fact.line.sent_date || fact.has_unconvertible_receipt) return [];
    const days = calendarDaysBetween(fact.line.sent_date, fact.completion_date);
    return days === null ? [] : [days];
  });
  const inspectedQty = facts.reduce((sum, fact) => sum + fact.inspected_qty, 0);
  const rejectedQty = facts.reduce((sum, fact) => sum + fact.rejected_qty, 0);
  const freshness = maxTimestamp(facts.flatMap((fact) => [fact.line.updated_at, ...fact.receipts.map((receipt) => receipt.updated_at)]));
  const unversioned = facts.filter((fact) => !fact.promise_versioned).length;
  const unitGaps = facts.filter((fact) => fact.has_unconvertible_receipt).length;
  const commonMissing = [
    ...(unversioned > 0 ? [`${unversioned} promesse(s) héritée(s) sans événement SOL-18`] : []),
    ...(unitGaps > 0 ? [`${unitGaps} ligne(s) avec unité non convertible`] : []),
  ];
  const actualReliability: ProcurementReliability = commonMissing.length === 0 ? "ACTUAL" : "PARTIAL";
  return {
    otd: {
      value: supplierOtdPct(onTime, due.length),
      definition: "Engagements fournisseurs arrivés à échéance et reçus intégralement au plus tard à la date promise / engagements arrivés à échéance.",
      unit: "%",
      period,
      source: ["commande_fournisseur_ligne", "procurement_promised_date_events", "reception_fournisseur_lignes"],
      freshness_at: freshness,
      reliability: due.length === 0 ? "UNAVAILABLE" : actualReliability,
      missing: due.length === 0 ? ["Aucun engagement arrivé à échéance sur la période"] : commonMissing,
      numerator: onTime,
      denominator: due.length,
    },
    lead_time_variability: {
      value: leadTimeVariabilityDays(leadTimes),
      definition: "Écart-type population du délai calendaire entre envoi de la commande et réception intégrale.",
      unit: "jours calendaires",
      period,
      source: ["commande_fournisseur.date_envoi", "receptions_fournisseurs.reception_date"],
      freshness_at: freshness,
      reliability: leadTimes.length < 2 ? "UNAVAILABLE" : actualReliability,
      missing: leadTimes.length < 2 ? ["Deux lignes réceptionnées avec date d'envoi sont requises"] : commonMissing,
      denominator: leadTimes.length,
    },
    price_variance: {
      value: null,
      definition: "(Montant facturé fournisseur rapproché - montant commandé) / montant commandé, pondéré par les montants rapprochés.",
      unit: "%",
      period,
      source: includePrices ? [] : ["HIDDEN_BY_RBAC"],
      freshness_at: null,
      reliability: "UNAVAILABLE",
      missing: [includePrices ? "Aucune facture fournisseur ni ligne d'avoir fournisseur n'est modélisée" : "Permission prix achats requise"],
    },
    rejection_rate: {
      value: rejectionRatePct(rejectedQty, inspectedQty),
      definition: "Quantité des lignes de réception inspectées avec décision BLOQUE / quantité totale des lignes inspectées et décidées.",
      unit: "% quantité en unité d'achat normalisée",
      period,
      source: ["reception_incoming_inspections", "reception_fournisseur_lignes", "lots"],
      freshness_at: freshness,
      reliability: inspectedQty <= 0 ? "UNAVAILABLE" : unitGaps > 0 ? "PARTIAL" : "ACTUAL",
      missing: inspectedQty <= 0 ? ["Aucune inspection décidée sur la période"] : unitGaps > 0 ? [`${unitGaps} ligne(s) avec unité non convertible`] : [],
      numerator: rejectedQty,
      denominator: inspectedQty,
    },
  };
}

function dimensionFor(fact: LineFact, dimension: ProcurementOverviewQueryDTO["dimension"]): { key: string; label: string } {
  if (dimension === "ARTICLE") {
    return {
      key: fact.line.article_id ?? `UNLINKED:${fact.line.line_id}`,
      label: fact.line.article_code ?? fact.line.article_name ?? fact.line.designation,
    };
  }
  if (dimension === "FAMILY") {
    return { key: fact.line.family_code ?? "UNCLASSIFIED", label: fact.line.family_code ?? "Famille non renseignée" };
  }
  return {
    key: fact.line.supplier_id,
    label: fact.line.supplier_name ?? fact.line.supplier_code ?? fact.line.supplier_id,
  };
}

function makeAnomaly(
  fact: LineFact,
  kind: string,
  severity: ProcurementAnomaly["severity"],
  label: string,
  evidence: Record<string, unknown>,
  recommendedAction: string,
  suggestedDueDate: string,
): ProcurementAnomaly {
  return {
    key: anomalyKey(kind, `${fact.line.line_id}:${kind}`),
    kind,
    severity,
    supplier_id: fact.line.supplier_id,
    order_id: fact.line.order_id,
    order_code: fact.line.order_code,
    line_id: fact.line.line_id,
    label,
    evidence,
    recommended_action: recommendedAction,
    suggested_due_date: suggestedDueDate,
    action: null,
  };
}

function buildAnomalies(facts: LineFact[], asOf: string): ProcurementAnomaly[] {
  const anomalies: ProcurementAnomaly[] = [];
  for (const fact of facts) {
    const line = fact.line;
    const allowedMax = fact.expected_qty * (1 + line.over_receipt_tolerance_pct / 100);
    const remaining = roundMetric(Math.max(0, fact.expected_qty - fact.received_qty), 6);
    if (fact.due && remaining > 0 && !fact.has_unconvertible_receipt) {
      anomalies.push(makeAnomaly(
        fact,
        "MISSING_QUANTITY",
        line.promised_date < asOf ? "P1" : "P2",
        `${line.order_code} — quantité ${fact.received_qty > 0 ? "partiellement reçue" : "non reçue"}`,
        { expected_qty: fact.expected_qty, received_qty: fact.received_qty, remaining_qty: remaining, unit: line.purchase_unit, promised_date: line.promised_date },
        "Confirmer la date et la quantité du prochain envoi fournisseur.",
        line.promised_date,
      ));
    }
    if (fact.received_qty > allowedMax + 1e-9) {
      anomalies.push(makeAnomaly(
        fact,
        "EXCESS_QUANTITY",
        "P1",
        `${line.order_code} — quantité reçue au-dessus de la tolérance`,
        { expected_qty: fact.expected_qty, received_qty: fact.received_qty, tolerance_pct: line.over_receipt_tolerance_pct, allowed_max_qty: roundMetric(allowedMax, 6), policy_source: line.policy_source ?? "STRICT_ZERO_TOLERANCE" },
        "Décider du retour fournisseur ou faire approuver l'écart avant mise en stock.",
        asOf,
      ));
    }
    const lateDays = fact.completion_date ? calendarDaysBetween(line.promised_date, fact.completion_date) : null;
    if (fact.completion_date && lateDays !== null && lateDays > line.lead_grace_days) {
      anomalies.push(makeAnomaly(
        fact,
        "LATE_RECEIPT",
        "P2",
        `${line.order_code} — réception intégrale tardive`,
        { promised_date: line.promised_date, completion_date: fact.completion_date, late_days: lateDays, grace_days: line.lead_grace_days, policy_source: line.policy_source ?? "STRICT_ZERO_GRACE" },
        "Qualifier la cause du retard avec le fournisseur.",
        fact.completion_date,
      ));
    }
    if (fact.has_unconvertible_receipt) {
      anomalies.push(makeAnomaly(
        fact,
        "UNIT_MISMATCH",
        "P1",
        `${line.order_code} — unité de réception non rapprochable`,
        { purchase_unit: line.purchase_unit, stock_unit: line.stock_unit, conversion_factor: line.conversion_factor, receipt_units: [...new Set(fact.receipts.map((receipt) => receipt.receipt_unit))] },
        "Renseigner une conversion explicite ou corriger l'unité de réception sans modifier l'historique.",
        asOf,
      ));
    }
    for (const receipt of fact.receipts.filter((candidate) => candidate.lot_status === "BLOQUE" || candidate.lot_status === "QUARANTAINE")) {
      anomalies.push(makeAnomaly(
        fact,
        "BLOCKED_LOT",
        "P1",
        `${line.order_code} — lot ${receipt.lot_code ?? receipt.lot_id ?? "sans code"} bloqué`,
        { receipt_id: receipt.receipt_id, receipt_no: receipt.receipt_no, lot_id: receipt.lot_id, lot_status: receipt.lot_status, inspection_decision: receipt.inspection_decision },
        "Ouvrir le contrôle réception et statuer sur le lot.",
        asOf,
      ));
    }
    if (fact.receipts.length > 0 && line.expected_documents.length > 0) {
      const present = new Set(fact.receipts.flatMap((receipt) => receipt.document_types.map((value) => value.toUpperCase())));
      const missing = line.expected_documents.filter((expected) => !present.has(expected.toUpperCase()));
      if (missing.length > 0) {
        anomalies.push(makeAnomaly(
          fact,
          "MISSING_DOCUMENT",
          "P2",
          `${line.order_code} — documents de réception absents`,
          { expected_documents: line.expected_documents, missing_documents: missing, present_documents: [...present] },
          "Demander et joindre les documents manquants à la réception.",
          asOf,
        ));
      }
    }
    const qualityRequired = line.quality_requirements.some((requirement) => requirement.obligatoire !== false && requirement.type === "CONTROLE_RECEPTION");
    if (qualityRequired && fact.receipts.some((receipt) => receipt.inspection_id === null)) {
      anomalies.push(makeAnomaly(
        fact,
        "QUALITY_INSPECTION_MISSING",
        "P1",
        `${line.order_code} — contrôle réception obligatoire non démarré`,
        { reception_lines_without_inspection: fact.receipts.filter((receipt) => receipt.inspection_id === null).map((receipt) => receipt.receipt_line_id) },
        "Démarrer le contrôle réception avant libération du lot.",
        asOf,
      ));
    }
  }
  return anomalies;
}

async function attachActions(anomalies: ProcurementAnomaly[]): Promise<void> {
  if (anomalies.length === 0) return;
  const result = await db.query<ActionRow>(
    `SELECT a.anomaly_key,a.owner_user_id,
            COALESCE(NULLIF(trim(concat_ws(' ',u.name,u.surname)),''),u.username) AS owner_name,
            a.next_action,a.due_date::text,a.status,a.resolution_note,a.updated_at::text
       FROM public.procurement_anomaly_actions a
       LEFT JOIN public.users u ON u.id=a.owner_user_id
      WHERE a.anomaly_key=ANY($1::text[])`,
    [anomalies.map((anomaly) => anomaly.key)],
  );
  const byKey = new Map(result.rows.map((row) => [row.anomaly_key, row]));
  for (const anomaly of anomalies) anomaly.action = byKey.get(anomaly.key) ?? null;
}

export async function repoProcurementOverview(query: ProcurementOverviewQueryDTO, includePrices: boolean) {
  await ensureInstalled();
  const asOf = query.as_of ?? new Date().toISOString().slice(0, 10);
  const period = { from: query.from, to: query.to, as_of: asOf };
  const lines = await loadLineRows(query, asOf);
  const [receipts, promiseHistory] = await Promise.all([
    loadReceiptRows(lines.map((line) => line.line_id), asOf),
    loadPromiseHistory(lines),
  ]);
  const facts = buildFacts(lines, receipts, promiseHistory, asOf);
  const anomalies = buildAnomalies(facts, asOf);
  await attachActions(anomalies);
  const grouped = new Map<string, { label: string; facts: LineFact[] }>();
  for (const fact of facts) {
    const dimension = dimensionFor(fact, query.dimension);
    const group = grouped.get(dimension.key) ?? { label: dimension.label, facts: [] };
    group.facts.push(fact);
    grouped.set(dimension.key, group);
  }
  const scorecards = [...grouped.entries()]
    .map(([key, value]) => ({ key, label: value.label, line_count: value.facts.length, metrics: metricSet(value.facts, period, includePrices) }))
    .sort((left, right) => (right.metrics.otd.denominator ?? 0) - (left.metrics.otd.denominator ?? 0) || left.label.localeCompare(right.label))
    .slice(0, query.limit);
  const promiseCoverage = facts.length === 0 ? null : roundMetric((facts.filter((fact) => fact.promise_versioned).length / facts.length) * 100, 2);
  return {
    contract_version: PROCUREMENT_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    timezone: PROCUREMENT_TIMEZONE,
    period,
    cohort: "PROMISED_DATE_DUE",
    dimension: query.dimension,
    metrics: metricSet(facts, period, includePrices),
    scorecards,
    anomalies: anomalies
      .sort((left, right) => left.severity.localeCompare(right.severity) || left.suggested_due_date.localeCompare(right.suggested_due_date))
      .slice(0, query.limit),
    reconciliation: facts.slice(0, query.limit).map((fact) => ({
      order: {
        id: fact.line.order_id,
        code: fact.line.order_code,
        line_id: fact.line.line_id,
        supplier_id: fact.line.supplier_id,
        article_id: fact.line.article_id,
        family_code: fact.line.family_code,
        expected_qty: fact.expected_qty,
        unit: fact.line.purchase_unit,
        promised_date: fact.line.promised_date,
        promised_date_source: fact.line.promised_date_source,
        promise_history: fact.promise_history,
      },
      receipts: fact.receipts.map((receipt) => ({
        id: receipt.receipt_id,
        no: receipt.receipt_no,
        line_id: receipt.receipt_line_id,
        date: receipt.receipt_date,
        qty: receipt.qty_received,
        unit: receipt.receipt_unit,
        normalized_purchase_qty: receipt.purchase_qty,
        normalization: receipt.normalization,
        quality_control: receipt.inspection_id === null ? null : {
          id: receipt.inspection_id,
          status: receipt.inspection_status,
          decision: receipt.inspection_decision,
          decided_at: receipt.inspection_decided_at,
        },
        lot: receipt.lot_id === null ? null : { id: receipt.lot_id, code: receipt.lot_code, status: receipt.lot_status },
        documents: receipt.document_types,
      })),
      supplier_invoice: { status: "UNAVAILABLE", reason: "SUPPLIER_INVOICE_SOURCE_NOT_MODELLED" },
      supplier_credit: { status: "UNAVAILABLE", reason: "SUPPLIER_CREDIT_SOURCE_NOT_MODELLED" },
      returns: { status: "UNAVAILABLE", reason: "SUPPLIER_RETURN_WORKFLOW_NOT_MODELLED" },
    })),
    capabilities: {
      purchase_order: { available: true, source: "commande_fournisseur" },
      receipt: { available: true, source: "receptions_fournisseurs" },
      incoming_quality: { available: true, source: "reception_incoming_inspections" },
      lot: { available: true, source: "lots" },
      supplier_invoice: { available: false, reason: "SUPPLIER_INVOICE_SOURCE_NOT_MODELLED" },
      supplier_credit: { available: false, reason: "SUPPLIER_CREDIT_SOURCE_NOT_MODELLED" },
      returns: { available: false, reason: "SUPPLIER_RETURN_WORKFLOW_NOT_MODELLED" },
    },
    data_quality: {
      line_count: facts.length,
      receipt_line_count: receipts.length,
      promise_history_coverage_pct: promiseCoverage,
      unconvertible_receipt_lines: facts.filter((fact) => fact.has_unconvertible_receipt).length,
      missing_price_policy_lines: facts.filter((fact) => fact.line.price_tolerance_pct === null).length,
      source_freshness_at: maxTimestamp(facts.flatMap((fact) => [fact.line.updated_at, ...fact.receipts.map((receipt) => receipt.updated_at)])),
    },
  };
}

export async function repoUpsertAnomalyAction(params: {
  anomalyKey: string;
  input: AnomalyActionBodyDTO;
  actor: ProcurementActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    await ensureInstalled(tx);
    const requestHash = procurementPayloadHash({ anomaly_key: params.anomalyKey, ...params.input });
    const replay = await readCommandReceipt<Record<string, unknown>>(tx, "ANOMALY_ACTION", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const current = await tx.query<{ updated_at: string }>(
      `SELECT updated_at::text FROM public.procurement_anomaly_actions WHERE anomaly_key=$1 FOR UPDATE`,
      [params.anomalyKey],
    );
    if (params.input.expected_updated_at && current.rows[0]?.updated_at !== params.input.expected_updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "L'anomalie a été modifiée. Rechargez la file avant de réessayer.");
    }
    const result = await tx.query<ActionRow>(
      `INSERT INTO public.procurement_anomaly_actions
         (anomaly_key,owner_user_id,next_action,due_date,status,resolution_note,created_by,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (anomaly_key) DO UPDATE SET
         owner_user_id=EXCLUDED.owner_user_id,next_action=EXCLUDED.next_action,due_date=EXCLUDED.due_date,
         status=EXCLUDED.status,resolution_note=EXCLUDED.resolution_note,updated_at=now(),updated_by=EXCLUDED.updated_by
       RETURNING anomaly_key,owner_user_id,NULL::text AS owner_name,next_action,due_date::text,status,resolution_note,updated_at::text`,
      [params.anomalyKey, params.input.owner_user_id, params.input.next_action, params.input.due_date, params.input.status,
        params.input.resolution_note ?? null, params.actor.user_id],
    );
    const response = { action: result.rows[0], idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "procurement.anomaly.action_updated",
      entity_type: "procurement_anomaly",
      entity_id: params.anomalyKey,
      details: { owner_user_id: params.input.owner_user_id, due_date: params.input.due_date, status: params.input.status },
    });
    await saveCommandReceipt(tx, "ANOMALY_ACTION", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoRecordPromisedDate(params: {
  orderId: string;
  input: PromisedDateBodyDTO;
  actor: ProcurementActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    await ensureInstalled(tx);
    const requestHash = procurementPayloadHash({ order_id: params.orderId, ...params.input });
    const replay = await readCommandReceipt<Record<string, unknown>>(tx, "PROMISED_DATE", params.idempotencyKey, requestHash);
    if (replay) return replay;
    const header = await tx.query<{ statut: string; updated_at: string; date_promesse: string | null }>(
      `SELECT statut,updated_at::text,date_promesse::text FROM public.commande_fournisseur WHERE id=$1::uuid FOR UPDATE`,
      [params.orderId],
    );
    const order = header.rows[0];
    if (!order) throw new HttpError(404, "COMMANDE_FOURNISSEUR_NOT_FOUND", "Commande fournisseur introuvable.");
    if (!['ENVOYEE','ACCUSE_RECU','PARTIELLEMENT_RECUE'].includes(order.statut)) {
      throw new HttpError(409, "PROMISE_REVISION_STATUS_INVALID", "Une promesse fournisseur ne peut être révisée que sur une commande envoyée et non clôturée.");
    }
    let previousDate: string | null = order.date_promesse;
    let optimisticToken = order.updated_at;
    if (params.input.line_id) {
      const line = await tx.query<{ date_promesse: string | null; updated_at: string }>(
        `SELECT date_promesse::text,updated_at::text FROM public.commande_fournisseur_ligne
         WHERE id=$1::uuid AND commande_id=$2::uuid AND statut_ligne='ACTIVE' FOR UPDATE`,
        [params.input.line_id, params.orderId],
      );
      if (!line.rows[0]) throw new HttpError(404, "COMMANDE_FOURNISSEUR_LINE_NOT_FOUND", "Ligne de commande introuvable.");
      previousDate = line.rows[0].date_promesse ?? order.date_promesse;
      optimisticToken = line.rows[0].updated_at;
    }
    if (optimisticToken !== params.input.expected_updated_at) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La promesse a été modifiée. Rechargez la commande avant de réessayer.");
    }
    if (previousDate === params.input.promised_date) {
      throw new HttpError(409, "PROMISE_DATE_UNCHANGED", "La nouvelle date promise est identique à la date actuelle.");
    }
    if (params.input.line_id) {
      await tx.query(
        `UPDATE public.commande_fournisseur_ligne SET date_promesse=$3::date,updated_at=now(),updated_by=$4
         WHERE id=$1::uuid AND commande_id=$2::uuid`,
        [params.input.line_id, params.orderId, params.input.promised_date, params.actor.user_id],
      );
    } else {
      await tx.query(
        `UPDATE public.commande_fournisseur SET date_promesse=$2::date,updated_at=now(),updated_by=$3 WHERE id=$1::uuid`,
        [params.orderId, params.input.promised_date, params.actor.user_id],
      );
    }
    const event = await tx.query<{ id: string; created_at: string }>(
      `INSERT INTO public.procurement_promised_date_events
         (commande_id,ligne_id,previous_date,promised_date,reason_code,note,actor_user_id)
       VALUES ($1::uuid,$2::uuid,$3::date,$4::date,$5,$6,$7)
       RETURNING id::text,created_at::text`,
      [params.orderId, params.input.line_id ?? null, previousDate, params.input.promised_date,
        params.input.reason_code, params.input.note ?? null, params.actor.user_id],
    );
    const response = { event_id: event.rows[0]?.id, promised_date: params.input.promised_date, idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "procurement.promise.revised",
      entity_type: params.input.line_id ? "commande_fournisseur_ligne" : "commande_fournisseur",
      entity_id: params.input.line_id ?? params.orderId,
      details: { order_id: params.orderId, previous_date: previousDate, promised_date: params.input.promised_date, reason_code: params.input.reason_code },
    });
    await saveCommandReceipt(tx, "PROMISED_DATE", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

export async function repoCreateProcurementPolicy(params: {
  input: ProcurementPolicyBodyDTO;
  actor: ProcurementActor;
  idempotencyKey: string;
}) {
  return inTransaction(async (tx) => {
    await ensureInstalled(tx);
    const requestHash = procurementPayloadHash(params.input);
    const replay = await readCommandReceipt<Record<string, unknown>>(tx, "POLICY_VERSION", params.idempotencyKey, requestHash);
    if (replay) return replay;
    let inserted;
    try {
      inserted = await tx.query<{ id: string; created_at: string }>(
        `INSERT INTO public.procurement_policy_versions
           (scope_type,scope_id,valid_from,price_tolerance_pct,over_receipt_tolerance_pct,lead_grace_days,reason,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id::text,created_at::text`,
        [params.input.scope_type, params.input.scope_id, params.input.valid_from, params.input.price_tolerance_pct,
          params.input.over_receipt_tolerance_pct, params.input.lead_grace_days, params.input.reason, params.actor.user_id],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new HttpError(409, "POLICY_VERSION_ALREADY_EXISTS", "Une politique existe déjà pour ce périmètre et cette date d'effet.");
      }
      throw error;
    }
    const response = { policy_id: inserted.rows[0]?.id, valid_from: params.input.valid_from, idempotent_replay: false };
    await insertAudit(tx, params.actor, {
      action: "procurement.policy.version_created",
      entity_type: "procurement_policy",
      entity_id: inserted.rows[0]?.id ?? "unknown",
      details: { scope_type: params.input.scope_type, scope_id: params.input.scope_id, valid_from: params.input.valid_from },
    });
    await saveCommandReceipt(tx, "POLICY_VERSION", params.idempotencyKey, requestHash, params.actor.user_id, response);
    return response;
  });
}

/** Called inside the existing acknowledgement transaction. */
export async function repoRecordInitialPromiseEvent(
  tx: Queryer,
  params: { orderId: string; previousDate: string | null; promisedDate: string; actorUserId: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO public.procurement_promised_date_events
       (commande_id,ligne_id,previous_date,promised_date,reason_code,actor_user_id)
     VALUES ($1::uuid,NULL,$2::date,$3::date,'SUPPLIER_ACKNOWLEDGEMENT',$4)`,
    [params.orderId, params.previousDate, params.promisedDate, params.actorUserId],
  );
}
