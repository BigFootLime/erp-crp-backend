import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type {
  MarginBasis,
  MarginCalculation,
  MarginCalculationInput,
  MarginCostInput,
  MarginEvidence,
  MarginRevenueInput,
  MarginScopeType,
} from "../domain/margin-engine";
import type { CreateMarginInput, CreateRateVersion } from "../validators/margin-engine.validators";

type ScopeIdentity = {
  scope_type: MarginScopeType;
  scope_ref: string;
  label: string;
  revenue_ht: string | null;
  source_observed_at: string | null;
};

export type MarginAuditContext = {
  user_id: number;
  ip: string | null;
  user_agent: string | null;
  device_type: string | null;
  os: string | null;
  browser: string | null;
  path: string | null;
  page_key: string;
  client_session_id: string | null;
};

async function auditMutation(
  tx: PoolClient,
  audit: MarginAuditContext,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
    body: {
      event_type: "ACTION",
      action,
      page_key: audit.page_key,
      entity_type: entityType,
      entity_id: entityId,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details,
    },
  });
}

const evidence = (
  sourceType: string,
  sourceRef: string | null,
  observedAt: string | null = null,
  metadata: Partial<Pick<MarginEvidence,
    "definition" | "unit" | "period_start" | "period_end" | "freshness_at" |
    "source_reliability" | "source_document_type" | "source_document_ref"
  >> = {},
): MarginEvidence => ({
  definition: metadata.definition ?? `Valeur issue de ${sourceType}.`,
  unit: metadata.unit ?? "EUR_HT",
  period_start: metadata.period_start ?? observedAt?.slice(0, 10) ?? "non-renseignée",
  period_end: metadata.period_end ?? observedAt?.slice(0, 10) ?? "non-renseignée",
  freshness_at: metadata.freshness_at ?? observedAt,
  source_reliability: metadata.source_reliability ?? "UNKNOWN",
  source_type: sourceType,
  source_ref: sourceRef,
  observed_at: observedAt,
  assumption: null,
  assumption_date: null,
  rate_version_id: null,
  rate_id: null,
  rate_effective_at: null,
  rate_scope_type: null,
  rate_scope_ref: null,
  source_document_type: metadata.source_document_type ?? sourceType,
  source_document_ref: metadata.source_document_ref ?? sourceRef,
});

function automaticCost(row: {
  key: string;
  category: MarginCostInput["category"];
  amount_ht: string | null;
  source_type: string;
  source_ref: string | null;
  observed_at: string | null;
  rate_version_id?: string | null;
}): MarginCostInput {
  return {
    key: row.key,
    category: row.category,
    availability: "PROVIDED",
    amount_ht: row.amount_ht,
    quantity: null,
    rate: null,
    rate_unit: null,
    currency: "EUR",
    evidence: {
      ...evidence(row.source_type, row.source_ref, row.observed_at, {
        definition: `Coût HT calculé depuis ${row.source_type}.`,
        source_reliability: row.source_type.includes("RECALC") || row.source_type.includes("STOCK") || row.source_type.includes("RECEPTION")
          ? "VERIFIED"
          : "ESTIMATED",
      }),
      rate_version_id: row.rate_version_id ?? null,
    },
  };
}

export async function repoLoadScopeIdentity(scopeType: MarginScopeType, scopeRef: string): Promise<ScopeIdentity | null> {
  if (scopeType === "DEVIS_LINE") {
    const result = await pool.query<ScopeIdentity>(`
      SELECT 'DEVIS_LINE'::text AS scope_type, dl.id::text AS scope_ref,
             concat(d.numero, ' · ', COALESCE(NULLIF(dl.description, ''), 'ligne ' || dl.id::text)) AS label,
             round(dl.total_ht * (1 - COALESCE(d.remise_globale, 0) / 100.0), 6)::text AS revenue_ht,
             d.updated_at::text AS source_observed_at
      FROM public.devis_ligne dl
      JOIN public.devis d ON d.id = dl.devis_id
      WHERE dl.id = $1::bigint
    `, [scopeRef]);
    return result.rows[0] ?? null;
  }
  if (scopeType === "DEVIS") {
    const result = await pool.query<ScopeIdentity>(`
      SELECT 'DEVIS'::text AS scope_type, id::text AS scope_ref, numero::text AS label,
             total_ht::text AS revenue_ht, updated_at::text AS source_observed_at
      FROM public.devis WHERE id = $1::bigint
    `, [scopeRef]);
    return result.rows[0] ?? null;
  }
  if (scopeType === "AFFAIRE") {
    const result = await pool.query<ScopeIdentity>(`
      SELECT 'AFFAIRE'::text AS scope_type, id::text AS scope_ref, reference::text AS label,
             NULL::text AS revenue_ht, NULL::text AS source_observed_at
      FROM public.affaire WHERE id = $1::bigint
    `, [scopeRef]);
    return result.rows[0] ?? null;
  }
  const result = await pool.query<ScopeIdentity>(`
    SELECT 'OF'::text AS scope_type, id::text AS scope_ref, numero::text AS label,
           NULL::text AS revenue_ht, NULL::text AS source_observed_at
    FROM public.ordres_fabrication WHERE id = $1::bigint
  `, [scopeRef]);
  return result.rows[0] ?? null;
}

type CostRow = {
  key: string;
  category: MarginCostInput["category"];
  amount_ht: string | null;
  source_type: string;
  source_ref: string | null;
  observed_at: string | null;
};

async function loadDevisCosts(scopeType: "DEVIS_LINE" | "DEVIS", scopeRef: string): Promise<MarginCostInput[]> {
  const linePredicate = scopeType === "DEVIS_LINE" ? "dl.id = $1::bigint" : "dl.devis_id = $1::bigint";
  const rows = await pool.query<CostRow>(`
    SELECT concat('purchase:', a.id::text) AS key,
           CASE
             WHEN a.type_achat = 'MATIERE' THEN 'MATERIAL'
             WHEN a.type_achat IN ('SOUS_TRAITANCE', 'TRAITEMENT') THEN 'SUBCONTRACTING'
             ELSE 'PURCHASE'
           END::text AS category,
           round(a.total_achat_ht * dl.quantite, 6)::text AS amount_ht,
           'PIECE_TECHNIQUE_ACHAT'::text AS source_type,
           a.id::text AS source_ref,
           a.updated_at::text AS observed_at
    FROM public.devis_ligne dl
    LEFT JOIN public.articles ar ON ar.id = dl.article_id
    JOIN public.pieces_techniques_achats a
      ON a.piece_technique_id = COALESCE(dl.piece_technique_id, ar.piece_technique_id)
    WHERE ${linePredicate} AND a.total_achat_ht IS NOT NULL
    UNION ALL
    SELECT concat('operation:', op.id::text) AS key,
           CASE
             WHEN op.type_operation = 'CONTROLE' THEN 'CONTROL'
             WHEN op.type_operation = 'EMBALLAGE' THEN 'PACKAGING'
             WHEN op.type_operation = 'SOUS_TRAITANCE' THEN 'SUBCONTRACTING'
             ELSE 'OPERATOR'
           END::text AS category,
           round(op.cout_mo, 6)::text AS amount_ht,
           'PIECE_TECHNIQUE_OPERATION'::text AS source_type,
           op.id::text AS source_ref,
           op.updated_at::text AS observed_at
    FROM public.devis_ligne dl
    LEFT JOIN public.articles ar ON ar.id = dl.article_id
    JOIN public.pieces_techniques_operations op
      ON op.piece_technique_id = COALESCE(dl.piece_technique_id, ar.piece_technique_id)
    WHERE ${linePredicate} AND op.cout_mo IS NOT NULL AND op.taux_horaire > 0
    ORDER BY key
  `, [scopeRef]);
  return rows.rows.map(automaticCost);
}

async function loadOfCosts(scopeRef: string, basis: MarginBasis): Promise<{ costs: MarginCostInput[]; measurements: Record<string, string | number | null> }> {
  const hoursColumn = basis === "STANDARD"
    ? "op.temps_total_planned"
    : basis === "UPDATED"
      ? "GREATEST(op.temps_total_planned, op.temps_total_real)"
      : "op.temps_total_real";
  const result = await pool.query<CostRow>(`
    SELECT concat('of-operation:', op.id::text) AS key,
           CASE WHEN op.designation ILIKE '%contrôle%' OR op.designation ILIKE '%controle%' THEN 'CONTROL' ELSE 'OPERATOR' END::text AS category,
           round(op.hourly_rate_applied * ${hoursColumn}, 6)::text AS amount_ht,
           ${basis === "STANDARD"
             ? "'OF_OPERATION_STANDARD'"
             : basis === "UPDATED"
               ? "'OF_OPERATION_ESTIMATE_AT_COMPLETION'"
               : "'PRODUCTION_POINTAGES_RECALC'"}::text AS source_type,
           op.id::text AS source_ref,
           op.updated_at::text AS observed_at
    FROM public.of_operations op
    WHERE op.of_id = $1::bigint
      AND op.hourly_rate_applied > 0
      AND ${hoursColumn} >= 0
    ORDER BY op.phase, op.id
  `, [scopeRef]);
  const measureResult = await pool.query<{
    planned_hours: string | null;
    actual_hours: string | null;
    good_quantity: string | null;
    scrap_quantity: string | null;
    rework_quantity: string | null;
    declaration_count: number;
    declaration_freshness: string | null;
  }>(`
    SELECT
      (SELECT sum(temps_total_planned) FROM public.of_operations WHERE of_id = $1::bigint)::text AS planned_hours,
      (SELECT sum(temps_total_real) FROM public.of_operations WHERE of_id = $1::bigint)::text AS actual_hours,
      (SELECT sum(qty_good) FROM public.production_quantity_declarations WHERE of_id = $1::bigint)::text AS good_quantity,
      (SELECT sum(qty_scrap) FROM public.production_quantity_declarations WHERE of_id = $1::bigint)::text AS scrap_quantity,
      (SELECT sum(qty_rework) FROM public.production_quantity_declarations WHERE of_id = $1::bigint)::text AS rework_quantity,
      (SELECT count(*)::integer FROM public.production_quantity_declarations WHERE of_id = $1::bigint) AS declaration_count,
      (SELECT max(declared_at)::text FROM public.production_quantity_declarations WHERE of_id = $1::bigint) AS declaration_freshness
  `, [scopeRef]);
  const measures = measureResult.rows[0] ?? {
    planned_hours: null, actual_hours: null, good_quantity: null,
    scrap_quantity: null, rework_quantity: null, declaration_count: 0, declaration_freshness: null,
  };
  const quantityCosts: MarginCostInput[] = [];
  if ((basis === "ACTUAL" || basis === "UPDATED") && measures.declaration_count > 0) {
    for (const [category, quantity] of [["SCRAP", measures.scrap_quantity], ["REWORK", measures.rework_quantity]] as const) {
      quantityCosts.push({
        key: `production-quantity:${category.toLowerCase()}`,
        category,
        availability: quantity !== null && Number(quantity) === 0 ? "NOT_APPLICABLE" : "PROVIDED",
        amount_ht: null,
        quantity,
        rate: null,
        rate_unit: null,
        currency: "EUR",
        evidence: evidence("PRODUCTION_QUANTITY_DECLARATIONS", scopeRef, measures.declaration_freshness, {
          definition: `${category === "SCRAP" ? "Rebuts" : "Retouches"} déclarés sur l'OF ; une quantité positive exige une valorisation versionnée.`,
          unit: "UNIT",
          source_reliability: "VERIFIED",
          source_document_type: "OF",
          source_document_ref: scopeRef,
        }),
      });
    }
  }
  const actualCosts = basis === "ACTUAL" || basis === "UPDATED"
    ? [...await loadActualMaterialCosts(scopeRef), ...await loadActualSubcontractingCosts(scopeRef)]
    : [];
  return {
    costs: [...result.rows.map(automaticCost), ...actualCosts, ...quantityCosts],
    measurements: measures,
  };
}

async function loadActualMaterialCosts(scopeRef: string): Promise<MarginCostInput[]> {
  const rows = await pool.query<CostRow>(`
    SELECT concat('stock-consumption:', line.id::text) AS key,
           'MATERIAL'::text AS category,
           CASE WHEN line.unit_cost IS NULL THEN NULL
                ELSE round(abs(line.qty) * line.unit_cost, 6)::text END AS amount_ht,
           'STOCK_CUMP_CONSUMPTION'::text AS source_type,
           movement.id::text AS source_ref,
           movement.posted_at::text AS observed_at
    FROM public.stock_movement_lines line
    JOIN public.stock_movements movement ON movement.id = line.movement_id
    WHERE movement.status::text = 'POSTED'
      AND movement.movement_type::text = 'OUT'
      AND EXISTS (
        SELECT 1 FROM public.stock_reservations reservation
        WHERE reservation.of_id = $1::bigint
          AND reservation.status::text = 'CONSUMED'
          AND reservation.consumed_stock_movement_id = movement.id
      )
    ORDER BY line.id
  `, [scopeRef]);
  return rows.rows.map(automaticCost);
}

async function loadActualSubcontractingCosts(scopeRef: string): Promise<MarginCostInput[]> {
  const rows = await pool.query<CostRow>(`
    SELECT concat('supplier-receipt:', receipt_line.id::text) AS key,
           'SUBCONTRACTING'::text AS category,
           CASE WHEN order_line.prix_unitaire_ht <= 0 THEN NULL
                ELSE round(
                  receipt_line.qty_received * order_line.prix_unitaire_ht * (1 - order_line.remise_pct / 100.0)
                  + CASE WHEN order_line.quantite > 0
                      THEN order_line.frais_ht * receipt_line.qty_received / order_line.quantite ELSE 0 END,
                  6
                )::text END AS amount_ht,
           'SUPPLIER_RECEPTION_ACTUAL'::text AS source_type,
           receipt.id::text AS source_ref,
           receipt_line.updated_at::text AS observed_at
    FROM public.reception_fournisseur_lignes receipt_line
    JOIN public.receptions_fournisseurs receipt ON receipt.id = receipt_line.reception_id
    JOIN public.commande_fournisseur_ligne order_line
      ON order_line.id = receipt_line.commande_fournisseur_ligne_id
    WHERE order_line.of_id = $1::bigint
      AND order_line.type IN ('SOUS_TRAITANCE','PRESTATION')
      AND order_line.statut_ligne <> 'ANNULEE'
      AND receipt.status::text <> 'CANCELLED'
      AND receipt_line.qty_received > 0
    ORDER BY receipt_line.id
  `, [scopeRef]);
  return rows.rows.map(automaticCost);
}

export type ManualInputRow = {
  input_key: string;
  input_kind: "REVENUE" | "COST";
  category: MarginCostInput["category"] | null;
  availability: "PROVIDED" | "NOT_APPLICABLE";
  amount_ht: string | null;
  quantity: string | null;
  currency: string;
  source_type: string;
  source_ref: string | null;
  observed_at: string | null;
  assumption: string | null;
  assumption_date: string | null;
  rate_id: string | null;
  rate_effective_at: string | null;
  rate_validation_snapshot: unknown;
  rate_amount: string | null;
  rate_unit: MarginCostInput["rate_unit"];
  rate_version_id: string | null;
  rate_category: MarginCostInput["category"] | null;
  rate_scope_type: string | null;
  rate_scope_ref: string | null;
  rate_effective_from: string | null;
  rate_effective_to: string | null;
  created_by: number;
  definition: string | null;
  unit: string | null;
  period_start: string | null;
  period_end: string | null;
  source_reliability: MarginEvidence["source_reliability"] | null;
  source_document_type: string | null;
  source_document_ref: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function rateUnitMatchesCategory(unit: MarginCostInput["rate_unit"], category: MarginCostInput["category"] | null): boolean {
  if (!unit || !category) return false;
  if (unit === "PERCENT_OF_DIRECT_COST") return category === "OVERHEAD";
  if (unit === "EUR_PER_HOUR") return ["MACHINE", "OPERATOR", "CONTROL"].includes(category);
  return !["OVERHEAD", "OPERATOR", "CONTROL"].includes(category);
}

export function isMarginRateResolutionValid(row: ManualInputRow, scopeType: MarginScopeType, scopeRef: string): boolean {
  if (row.rate_id === null) return true;
  const snapshot = record(row.rate_validation_snapshot);
  if (
    !snapshot || row.rate_amount === null || row.rate_unit === null || row.rate_version_id === null ||
    row.rate_category !== row.category || row.rate_effective_at === null || row.rate_effective_from === null ||
    !rateUnitMatchesCategory(row.rate_unit, row.category)
  ) return false;
  if (row.rate_effective_at < row.rate_effective_from || (row.rate_effective_to !== null && row.rate_effective_at > row.rate_effective_to)) return false;
  if (row.rate_unit === "PERCENT_OF_DIRECT_COST" ? row.quantity !== null : row.quantity === null) return false;
  return snapshot.rate_id === row.rate_id &&
    snapshot.rate_version_id === row.rate_version_id &&
    snapshot.category === row.rate_category &&
    snapshot.unit === row.rate_unit &&
    snapshot.scope_type === row.rate_scope_type &&
    (snapshot.scope_ref ?? null) === row.rate_scope_ref &&
    snapshot.rate_effective_at === row.rate_effective_at &&
    snapshot.validated_scope_type === scopeType &&
    snapshot.validated_scope_ref === scopeRef;
}

async function loadManualInputs(scopeType: MarginScopeType, scopeRef: string, basis: MarginBasis, asOf: string): Promise<{
  revenue: MarginRevenueInput | null;
  costs: MarginCostInput[];
}> {
  const result = await pool.query<ManualInputRow>(`
    SELECT DISTINCT ON (i.input_key)
      i.input_key, i.input_kind, i.category, i.availability,
      i.amount_ht::text, i.quantity::text, i.currency,
      i.source_type, i.source_ref, i.observed_at::text,
      i.assumption, i.assumption_date::text,
      i.definition, i.unit, i.period_start::text, i.period_end::text,
      i.source_reliability, i.source_document_type, i.source_document_ref,
      i.created_by,
      i.rate_id::text, i.rate_effective_at::text, i.rate_validation_snapshot,
      r.amount::text AS rate_amount, r.unit AS rate_unit,
      r.rate_version_id::text AS rate_version_id, r.category AS rate_category,
      r.scope_type AS rate_scope_type, r.scope_ref AS rate_scope_ref,
      v.effective_from::text AS rate_effective_from, v.effective_to::text AS rate_effective_to
    FROM public.margin_input_versions i
    LEFT JOIN public.margin_input_versions successor
      ON successor.supersedes_id = i.id
     AND successor.created_at < ($4::date + interval '1 day')
    LEFT JOIN public.margin_rates r ON r.id = i.rate_id
    LEFT JOIN public.margin_rate_versions v ON v.id = r.rate_version_id
    WHERE i.scope_type = $1 AND i.scope_ref = $2
      AND (i.basis = $3 OR ($3 = 'STANDARD' AND i.basis = 'PLANNED'))
      AND i.created_at < ($4::date + interval '1 day')
      AND successor.id IS NULL
    ORDER BY i.input_key, (i.basis = $3) DESC, i.created_at DESC, i.id DESC
  `, [scopeType, scopeRef, basis, asOf]);
  let revenue: MarginRevenueInput | null = null;
  const costs: MarginCostInput[] = [];
  for (const row of result.rows) {
    let rateResolved = isMarginRateResolutionValid(row, scopeType, scopeRef);
    if (rateResolved && row.rate_id !== null) {
      rateResolved = await scopedRateMatchesTarget(
        pool,
        { scope_type: scopeType, scope_ref: scopeRef },
        { scope_type: row.rate_scope_type!, scope_ref: row.rate_scope_ref },
        row.created_by,
      );
    }
    const sourceEvidence: MarginEvidence = {
      definition: row.definition ?? `Entrée versionnée ${row.input_key}.`,
      unit: row.unit ?? (row.input_kind === "REVENUE" || row.amount_ht !== null ? "EUR_HT" : row.rate_unit ?? "non-renseignée"),
      period_start: row.period_start ?? row.assumption_date ?? row.observed_at?.slice(0, 10) ?? "non-renseignée",
      period_end: row.period_end ?? row.assumption_date ?? row.observed_at?.slice(0, 10) ?? "non-renseignée",
      freshness_at: row.observed_at,
      source_reliability: row.source_reliability ?? "UNKNOWN",
      source_type: row.source_type,
      source_ref: row.source_ref,
      observed_at: row.observed_at,
      assumption: row.assumption,
      assumption_date: row.assumption_date,
      rate_version_id: row.rate_version_id,
      rate_id: row.rate_id,
      rate_effective_at: row.rate_effective_at,
      rate_scope_type: row.rate_scope_type,
      rate_scope_ref: row.rate_scope_ref,
      source_document_type: row.source_document_type,
      source_document_ref: row.source_document_ref,
    };
    if (row.input_kind === "REVENUE") {
      revenue = { availability: row.availability, amount_ht: row.amount_ht, currency: row.currency, evidence: sourceEvidence };
    } else if (row.category) {
      costs.push({
        key: row.input_key,
        category: row.category,
        availability: row.availability,
        amount_ht: rateResolved ? row.amount_ht : null,
        quantity: row.quantity,
        rate: rateResolved ? row.rate_amount : null,
        rate_unit: row.rate_unit,
        currency: row.currency,
        evidence: sourceEvidence,
      });
    }
  }
  return { revenue, costs };
}

export async function repoBuildCalculationInput(identity: ScopeIdentity, basis: MarginBasis, asOf: string): Promise<MarginCalculationInput> {
  const manual = await loadManualInputs(identity.scope_type, identity.scope_ref, basis, asOf);
  let automaticCosts: MarginCostInput[] = [];
  let measurements: Record<string, string | number | null> = {};
  if ((basis === "QUOTED" || basis === "STANDARD") && (identity.scope_type === "DEVIS" || identity.scope_type === "DEVIS_LINE")) {
    automaticCosts = await loadDevisCosts(identity.scope_type, identity.scope_ref);
  } else if (identity.scope_type === "OF" && basis !== "QUOTED") {
    const ofData = await loadOfCosts(identity.scope_ref, basis);
    automaticCosts = ofData.costs;
    measurements = ofData.measurements;
  }
  const canonicalRevenue: MarginRevenueInput | null = identity.revenue_ht === null ? null : {
    availability: "PROVIDED",
    amount_ht: identity.revenue_ht,
    currency: "EUR",
    evidence: evidence(identity.scope_type === "DEVIS" ? "DEVIS_TOTAL_HT" : "DEVIS_LINE_TOTAL_HT", identity.scope_ref, identity.source_observed_at, {
      definition: "Prix de vente HT après remises porté par le devis.",
      period_start: asOf,
      period_end: asOf,
      source_reliability: "VERIFIED",
      source_document_type: identity.scope_type,
      source_document_ref: identity.scope_ref,
    }),
  };
  return {
    scope_type: identity.scope_type,
    scope_ref: identity.scope_ref,
    label: identity.label,
    basis,
    as_of: asOf,
    revenue: canonicalRevenue ?? manual.revenue,
    costs: [...automaticCosts, ...manual.costs],
    measurements,
  };
}

type RateValidationRow = {
  id: string;
  category: MarginCostInput["category"];
  unit: NonNullable<MarginCostInput["rate_unit"]>;
  scope_type: string;
  scope_ref: string | null;
  rate_version_id: string;
  effective_from: string;
  effective_to: string | null;
};

async function scopedRateMatchesTarget(
  tx: Pick<PoolClient, "query">,
  input: Pick<CreateMarginInput, "scope_type" | "scope_ref">,
  rate: Pick<RateValidationRow, "scope_type" | "scope_ref">,
  userId: number,
): Promise<boolean> {
  if (rate.scope_type === "GLOBAL") return rate.scope_ref === null;
  if (rate.scope_type === "USER") return rate.scope_ref === String(userId);
  if (!rate.scope_ref) return false;
  const result = await tx.query<{ matches: boolean }>(`
    WITH target_devis AS (
      SELECT d.id
      FROM public.devis d
      WHERE ($1 = 'DEVIS' AND d.id = $2::bigint)
      UNION
      SELECT dl.devis_id
      FROM public.devis_ligne dl
      WHERE $1 = 'DEVIS_LINE' AND dl.id = $2::bigint
      UNION
      SELECT a.devis_id
      FROM public.affaire a
      WHERE $1 = 'AFFAIRE' AND a.id = $2::bigint AND a.devis_id IS NOT NULL
    ), target_ofs AS (
      SELECT o.id, o.piece_technique_id
      FROM public.ordres_fabrication o
      WHERE ($1 = 'OF' AND o.id = $2::bigint)
         OR ($1 = 'AFFAIRE' AND o.affaire_id = $2::bigint)
         OR EXISTS (
           SELECT 1 FROM public.affaire a
           JOIN target_devis d ON d.id = a.devis_id
           WHERE a.id = o.affaire_id
         )
    ), target_pieces AS (
      SELECT piece_technique_id AS id FROM target_ofs
      UNION
      SELECT COALESCE(dl.piece_technique_id, ar.piece_technique_id)
      FROM public.devis_ligne dl
      LEFT JOIN public.articles ar ON ar.id = dl.article_id
      WHERE (($1 = 'DEVIS_LINE' AND dl.id = $2::bigint)
          OR ($1 <> 'DEVIS_LINE' AND dl.devis_id IN (SELECT id FROM target_devis)))
        AND COALESCE(dl.piece_technique_id, ar.piece_technique_id) IS NOT NULL
    )
    SELECT CASE $3
      WHEN 'PIECE_TECHNIQUE' THEN EXISTS (SELECT 1 FROM target_pieces p WHERE p.id::text = $4)
      WHEN 'MACHINE' THEN
        EXISTS (SELECT 1 FROM public.pieces_techniques_operations op JOIN target_pieces p ON p.id = op.piece_technique_id WHERE op.machine_id::text = $4)
        OR EXISTS (SELECT 1 FROM public.of_operations op JOIN target_ofs o ON o.id = op.of_id AND o.piece_technique_id IN (SELECT id FROM target_pieces) WHERE op.machine_id::text = $4)
      WHEN 'COST_CENTER' THEN
        EXISTS (SELECT 1 FROM public.pieces_techniques_operations op JOIN target_pieces p ON p.id = op.piece_technique_id WHERE op.cf_id::text = $4)
        OR EXISTS (SELECT 1 FROM public.of_operations op JOIN target_ofs o ON o.id = op.of_id AND o.piece_technique_id IN (SELECT id FROM target_pieces) WHERE op.cf_id::text = $4)
      ELSE false
    END AS matches
  `, [input.scope_type, input.scope_ref, rate.scope_type, rate.scope_ref]);
  return result.rows[0]?.matches === true;
}

export async function validateRateForInput(
  tx: PoolClient,
  input: CreateMarginInput,
  userId: number,
): Promise<Record<string, unknown> | null> {
  if (!input.rate_id) return null;
  if (input.input_kind !== "COST" || !input.category || input.amount_ht != null || !input.rate_effective_at) {
    throw new HttpError(422, "MARGIN_RATE_INPUT_INVALID", "Un taux s'applique uniquement à un coût sans montant direct et avec une date d'application.");
  }
  const result = await tx.query<RateValidationRow>(`
    SELECT r.id::text, r.category, r.unit, r.scope_type, r.scope_ref,
           r.rate_version_id::text, v.effective_from::text, v.effective_to::text
    FROM public.margin_rates r
    JOIN public.margin_rate_versions v ON v.id = r.rate_version_id
    WHERE r.id = $1::uuid
    FOR SHARE
  `, [input.rate_id]);
  const rate = result.rows[0];
  if (!rate) throw new HttpError(422, "MARGIN_RATE_NOT_FOUND", "Taux de marge introuvable.");
  if (rate.category !== input.category || !rateUnitMatchesCategory(rate.unit, input.category)) {
    throw new HttpError(422, "MARGIN_RATE_CATEGORY_UNIT_MISMATCH", "La catégorie ou l'unité du taux ne correspond pas au coût.");
  }
  if (rate.unit === "PERCENT_OF_DIRECT_COST" ? input.quantity != null : input.quantity == null) {
    throw new HttpError(422, "MARGIN_RATE_QUANTITY_INVALID", rate.unit === "PERCENT_OF_DIRECT_COST"
      ? "Un taux de frais généraux ne porte pas de quantité."
      : "Une quantité est requise pour ce taux.");
  }
  if (input.rate_effective_at < rate.effective_from || (rate.effective_to !== null && input.rate_effective_at > rate.effective_to)) {
    throw new HttpError(422, "MARGIN_RATE_OUTSIDE_EFFECTIVE_PERIOD", "Le taux n'est pas applicable à la date demandée.");
  }
  if (!(await scopedRateMatchesTarget(tx, input, rate, userId))) {
    throw new HttpError(422, "MARGIN_RATE_SCOPE_MISMATCH", "La portée du taux ne correspond pas au périmètre métier.");
  }
  return {
    rate_id: rate.id,
    rate_version_id: rate.rate_version_id,
    category: rate.category,
    unit: rate.unit,
    scope_type: rate.scope_type,
    scope_ref: rate.scope_ref,
    effective_from: rate.effective_from,
    effective_to: rate.effective_to,
    rate_effective_at: input.rate_effective_at,
    validated_scope_type: input.scope_type,
    validated_scope_ref: input.scope_ref,
  };
}

export async function repoCreateMarginInput(input: CreateMarginInput, audit: MarginAuditContext): Promise<{ id: string; created_at: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.supersedes_id) {
      const predecessor = await client.query<{ scope_type: string; scope_ref: string; basis: string; input_key: string }>(`
        SELECT scope_type, scope_ref, basis, input_key
        FROM public.margin_input_versions
        WHERE id = $1::uuid FOR SHARE
      `, [input.supersedes_id]);
      const row = predecessor.rows[0];
      if (!row || row.scope_type !== input.scope_type || row.scope_ref !== input.scope_ref || row.basis !== input.basis || row.input_key !== input.input_key) {
        throw new HttpError(409, "MARGIN_SUPERSEDES_MISMATCH", "La version remplacée doit porter la même entrée et le même périmètre.");
      }
    }
    const rateSnapshot = await validateRateForInput(client, input, audit.user_id);
    const result = await client.query<{ id: string; created_at: string }>(`
      INSERT INTO public.margin_input_versions (
        scope_type, scope_ref, basis, input_key, input_kind, category, availability,
        amount_ht, quantity, rate_id, rate_effective_at, rate_validation_snapshot,
        source_type, source_ref, observed_at, assumption, assumption_date,
        definition, unit, period_start, period_end, source_reliability,
        source_document_type, source_document_ref, supersedes_id, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::uuid,$11::date,$12::jsonb,$13,$14,$15::timestamptz,$16,$17::date,$18,$19,$20::date,$21::date,$22,$23,$24,$25::uuid,$26)
      RETURNING id::text, created_at::text
    `, [
      input.scope_type, input.scope_ref, input.basis, input.input_key, input.input_kind,
      input.category ?? null, input.availability, input.amount_ht ?? null, input.quantity ?? null,
      input.rate_id ?? null, input.rate_effective_at ?? null, rateSnapshot ? JSON.stringify(rateSnapshot) : null,
      input.source_type, input.source_ref ?? null, input.observed_at ?? null,
      input.assumption ?? null, input.assumption_date ?? null,
      input.definition, input.unit, input.period_start, input.period_end, input.source_reliability,
      input.source_document_type ?? null, input.source_document_ref ?? null,
      input.supersedes_id ?? null, audit.user_id,
    ]);
    const created = result.rows[0]!;
    await auditMutation(client, audit, "MARGIN_INPUT_VERSION_CREATED", "margin_input_version", created.id, {
      scope_type: input.scope_type, scope_ref: input.scope_ref, basis: input.basis,
      input_key: input.input_key, supersedes_id: input.supersedes_id ?? null,
      rate_id: input.rate_id ?? null, rate_effective_at: input.rate_effective_at ?? null,
    });
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCreateRateVersion(input: CreateRateVersion, audit: MarginAuditContext): Promise<{ id: string; created_at: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (input.supersedes_id) {
      const predecessor = await client.query<{ code: string; version: number }>(`
        SELECT code, version FROM public.margin_rate_versions WHERE id = $1::uuid FOR SHARE
      `, [input.supersedes_id]);
      const row = predecessor.rows[0];
      if (!row || row.code !== input.code || input.version <= row.version) {
        throw new HttpError(409, "MARGIN_RATE_SUPERSEDES_MISMATCH", "La nouvelle version doit remplacer une version antérieure du même référentiel.");
      }
    }
    const version = await client.query<{ id: string; created_at: string }>(`
      INSERT INTO public.margin_rate_versions
        (code, version, effective_from, effective_to, source, source_reliability, assumption_date, notes, supersedes_id, created_by)
      VALUES ($1,$2,$3::date,$4::date,$5,$6,$7::date,$8,$9::uuid,$10)
      RETURNING id::text, created_at::text
    `, [input.code, input.version, input.effective_from, input.effective_to ?? null, input.source, input.source_reliability,
      input.assumption_date, input.notes ?? null, input.supersedes_id ?? null, audit.user_id]);
    const versionId = version.rows[0]!.id;
    for (const rate of input.rates) {
      await client.query(`
        INSERT INTO public.margin_rates
          (rate_version_id, rate_code, category, scope_type, scope_ref, amount, unit, source_ref)
        VALUES ($1::uuid,$2,$3,$4,$5,$6::numeric,$7,$8)
      `, [versionId, rate.rate_code, rate.category, rate.scope_type, rate.scope_ref ?? null, rate.amount, rate.unit, rate.source_ref ?? null]);
    }
    await auditMutation(client, audit, "MARGIN_RATE_VERSION_CREATED", "margin_rate_version", versionId, {
      code: input.code, version: input.version, effective_from: input.effective_from,
      effective_to: input.effective_to ?? null, supersedes_id: input.supersedes_id ?? null,
      rate_count: input.rates.length,
    });
    await client.query("COMMIT");
    return version.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListRateVersions(asOf: string): Promise<unknown[]> {
  const result = await pool.query(`
    SELECT v.id::text, v.code, v.version, v.currency, v.effective_from::text, v.effective_to::text,
           v.source, v.source_reliability, v.assumption_date::text, v.notes, v.supersedes_id::text, v.created_by, v.created_at::text,
           COALESCE(jsonb_agg(jsonb_build_object(
             'id', r.id::text, 'rate_code', r.rate_code, 'category', r.category,
             'scope_type', r.scope_type, 'scope_ref', r.scope_ref, 'amount', r.amount::text,
             'unit', r.unit, 'source_ref', r.source_ref
           ) ORDER BY r.rate_code) FILTER (WHERE r.id IS NOT NULL), '[]'::jsonb) AS rates
    FROM public.margin_rate_versions v
    LEFT JOIN public.margin_rates r ON r.rate_version_id = v.id
    WHERE v.effective_from <= $1::date AND (v.effective_to IS NULL OR v.effective_to >= $1::date)
    GROUP BY v.id
    ORDER BY v.code, v.version DESC
  `, [asOf]);
  return result.rows;
}

export async function repoCreateSnapshot(calculation: MarginCalculation, input: MarginCalculationInput, audit: MarginAuditContext): Promise<{ id: string; created_at: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string; created_at: string }>(`
      INSERT INTO public.margin_recalculations
        (scope_type, scope_ref, basis, as_of, formula_version, calculation_hash, input_snapshot, result_snapshot, created_by)
      VALUES ($1,$2,$3,$4::date,$5,$6,$7::jsonb,$8::jsonb,$9)
      RETURNING id::text, created_at::text
    `, [calculation.scope.type, calculation.scope.ref, calculation.basis, calculation.as_of, calculation.formula_version,
        calculation.calculation_hash, JSON.stringify(input), JSON.stringify(calculation), audit.user_id]);
    const created = result.rows[0]!;
    await auditMutation(client, audit, "MARGIN_RECALCULATION_SNAPSHOTTED", "margin_recalculation", created.id, {
      scope_type: calculation.scope.type, scope_ref: calculation.scope.ref,
      basis: calculation.basis, as_of: calculation.as_of,
      formula_version: calculation.formula_version, calculation_hash: calculation.calculation_hash,
    });
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListSnapshots(
  scopeType: MarginScopeType,
  scopeRef: string,
  filters: { basis?: MarginBasis; as_of?: string },
): Promise<unknown[]> {
  const result = await pool.query(`
    SELECT id::text, scope_type, scope_ref, basis, as_of::text, formula_version,
           calculation_hash, input_snapshot, result_snapshot, created_by, created_at::text
    FROM public.margin_recalculations
    WHERE scope_type = $1 AND scope_ref = $2
      AND ($3::text IS NULL OR basis = $3)
      AND ($4::date IS NULL OR as_of = $4::date)
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `, [scopeType, scopeRef, filters.basis ?? null, filters.as_of ?? null]);
  return result.rows;
}
