import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
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
};

const evidence = (sourceType: string, sourceRef: string | null, observedAt: string | null = null): MarginEvidence => ({
  source_type: sourceType,
  source_ref: sourceRef,
  observed_at: observedAt,
  assumption: null,
  assumption_date: null,
  rate_version_id: null,
});

function automaticCost(row: {
  key: string;
  category: MarginCostInput["category"];
  amount_ht: string;
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
    evidence: { ...evidence(row.source_type, row.source_ref, row.observed_at), rate_version_id: row.rate_version_id ?? null },
  };
}

export async function repoLoadScopeIdentity(scopeType: MarginScopeType, scopeRef: string): Promise<ScopeIdentity | null> {
  if (scopeType === "DEVIS_LINE") {
    const result = await pool.query<ScopeIdentity>(`
      SELECT 'DEVIS_LINE'::text AS scope_type, dl.id::text AS scope_ref,
             concat(d.numero, ' · ', COALESCE(NULLIF(dl.description, ''), 'ligne ' || dl.id::text)) AS label,
             round(dl.total_ht * (1 - COALESCE(d.remise_globale, 0) / 100.0), 6)::text AS revenue_ht
      FROM public.devis_ligne dl
      JOIN public.devis d ON d.id = dl.devis_id
      WHERE dl.id = $1::bigint
    `, [scopeRef]);
    return result.rows[0] ?? null;
  }
  if (scopeType === "DEVIS") {
    const result = await pool.query<ScopeIdentity>(`
      SELECT 'DEVIS'::text AS scope_type, id::text AS scope_ref, numero::text AS label,
             total_ht::text AS revenue_ht FROM public.devis WHERE id = $1::bigint
    `, [scopeRef]);
    return result.rows[0] ?? null;
  }
  if (scopeType === "AFFAIRE") {
    const result = await pool.query<ScopeIdentity>(`
      SELECT 'AFFAIRE'::text AS scope_type, id::text AS scope_ref, reference::text AS label,
             NULL::text AS revenue_ht FROM public.affaire WHERE id = $1::bigint
    `, [scopeRef]);
    return result.rows[0] ?? null;
  }
  const result = await pool.query<ScopeIdentity>(`
    SELECT 'OF'::text AS scope_type, id::text AS scope_ref, numero::text AS label,
           NULL::text AS revenue_ht FROM public.ordres_fabrication WHERE id = $1::bigint
  `, [scopeRef]);
  return result.rows[0] ?? null;
}

type CostRow = {
  key: string;
  category: MarginCostInput["category"];
  amount_ht: string;
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
           round(op.cout_mo * dl.quantite, 6)::text AS amount_ht,
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
  const hoursColumn = basis === "PLANNED" ? "op.temps_total_planned" : "op.temps_total_real";
  const result = await pool.query<CostRow>(`
    SELECT concat('of-operation:', op.id::text) AS key,
           CASE WHEN op.designation ILIKE '%contrôle%' OR op.designation ILIKE '%controle%' THEN 'CONTROL' ELSE 'OPERATOR' END::text AS category,
           round(op.hourly_rate_applied * ${hoursColumn}, 6)::text AS amount_ht,
           ${basis === "PLANNED" ? "'OF_OPERATION_PLAN'" : "'PRODUCTION_POINTAGES_RECALC'"}::text AS source_type,
           op.id::text AS source_ref,
           op.updated_at::text AS observed_at
    FROM public.of_operations op
    WHERE op.of_id = $1::bigint
      AND op.hourly_rate_applied > 0
      AND ${hoursColumn} >= 0
    ORDER BY op.phase, op.id
  `, [scopeRef]);
  const measureResult = await pool.query<{
    planned_hours: string;
    actual_hours: string;
    good_quantity: string;
    scrap_quantity: string;
    rework_quantity: string;
  }>(`
    SELECT
      COALESCE((SELECT sum(temps_total_planned) FROM public.of_operations WHERE of_id = $1::bigint), 0)::text AS planned_hours,
      COALESCE((SELECT sum(temps_total_real) FROM public.of_operations WHERE of_id = $1::bigint), 0)::text AS actual_hours,
      COALESCE((SELECT sum(qty_good) FROM public.production_quantity_declarations WHERE of_id = $1::bigint), 0)::text AS good_quantity,
      COALESCE((SELECT sum(qty_scrap) FROM public.production_quantity_declarations WHERE of_id = $1::bigint), 0)::text AS scrap_quantity,
      COALESCE((SELECT sum(qty_rework) FROM public.production_quantity_declarations WHERE of_id = $1::bigint), 0)::text AS rework_quantity
  `, [scopeRef]);
  return {
    costs: result.rows.map(automaticCost),
    measurements: measureResult.rows[0] ?? {},
  };
}

type ManualInputRow = {
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
  rate_amount: string | null;
  rate_unit: MarginCostInput["rate_unit"];
  rate_version_id: string | null;
};

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
      i.rate_id::text, r.amount::text AS rate_amount, r.unit AS rate_unit,
      r.rate_version_id::text AS rate_version_id
    FROM public.margin_input_versions i
    LEFT JOIN public.margin_input_versions successor
      ON successor.supersedes_id = i.id
     AND successor.created_at < ($4::date + interval '1 day')
    LEFT JOIN public.margin_rates r ON r.id = i.rate_id
    WHERE i.scope_type = $1 AND i.scope_ref = $2 AND i.basis = $3
      AND i.created_at < ($4::date + interval '1 day')
      AND successor.id IS NULL
    ORDER BY i.input_key, i.created_at DESC, i.id DESC
  `, [scopeType, scopeRef, basis, asOf]);
  let revenue: MarginRevenueInput | null = null;
  const costs: MarginCostInput[] = [];
  for (const row of result.rows) {
    const sourceEvidence: MarginEvidence = {
      source_type: row.source_type,
      source_ref: row.source_ref,
      observed_at: row.observed_at,
      assumption: row.assumption,
      assumption_date: row.assumption_date,
      rate_version_id: row.rate_version_id,
    };
    if (row.input_kind === "REVENUE") {
      revenue = { availability: row.availability, amount_ht: row.amount_ht, currency: row.currency, evidence: sourceEvidence };
    } else if (row.category) {
      costs.push({
        key: row.input_key,
        category: row.category,
        availability: row.availability,
        amount_ht: row.amount_ht,
        quantity: row.quantity,
        rate: row.rate_amount,
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
  if (basis === "PLANNED" && (identity.scope_type === "DEVIS" || identity.scope_type === "DEVIS_LINE")) {
    automaticCosts = await loadDevisCosts(identity.scope_type, identity.scope_ref);
  } else if (identity.scope_type === "OF") {
    const ofData = await loadOfCosts(identity.scope_ref, basis);
    automaticCosts = ofData.costs;
    measurements = ofData.measurements;
  }
  const canonicalRevenue: MarginRevenueInput | null = identity.revenue_ht === null ? null : {
    availability: "PROVIDED",
    amount_ht: identity.revenue_ht,
    currency: "EUR",
    evidence: evidence(identity.scope_type === "DEVIS" ? "DEVIS_TOTAL_HT" : "DEVIS_LINE_TOTAL_HT", identity.scope_ref),
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

export async function repoCreateMarginInput(input: CreateMarginInput, userId: number): Promise<{ id: string; created_at: string }> {
  if (input.supersedes_id) {
    const predecessor = await pool.query<{ scope_type: string; scope_ref: string; basis: string; input_key: string }>(`
      SELECT scope_type, scope_ref, basis, input_key
      FROM public.margin_input_versions
      WHERE id = $1::uuid
    `, [input.supersedes_id]);
    const row = predecessor.rows[0];
    if (!row || row.scope_type !== input.scope_type || row.scope_ref !== input.scope_ref || row.basis !== input.basis || row.input_key !== input.input_key) {
      throw new HttpError(409, "MARGIN_SUPERSEDES_MISMATCH", "La version remplacée doit porter la même entrée et le même périmètre.");
    }
  }
  const result = await pool.query<{ id: string; created_at: string }>(`
    INSERT INTO public.margin_input_versions (
      scope_type, scope_ref, basis, input_key, input_kind, category, availability,
      amount_ht, quantity, rate_id, source_type, source_ref, observed_at,
      assumption, assumption_date, supersedes_id, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::numeric,$9::numeric,$10::uuid,$11,$12,$13::timestamptz,$14,$15::date,$16::uuid,$17)
    RETURNING id::text, created_at::text
  `, [
    input.scope_type, input.scope_ref, input.basis, input.input_key, input.input_kind,
    input.category ?? null, input.availability, input.amount_ht ?? null, input.quantity ?? null,
    input.rate_id ?? null, input.source_type, input.source_ref ?? null, input.observed_at ?? null,
    input.assumption ?? null, input.assumption_date ?? null, input.supersedes_id ?? null, userId,
  ]);
  return result.rows[0]!;
}

export async function repoCreateRateVersion(input: CreateRateVersion, userId: number): Promise<{ id: string; created_at: string }> {
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
        (code, version, effective_from, effective_to, source, assumption_date, notes, supersedes_id, created_by)
      VALUES ($1,$2,$3::date,$4::date,$5,$6::date,$7,$8::uuid,$9)
      RETURNING id::text, created_at::text
    `, [input.code, input.version, input.effective_from, input.effective_to ?? null, input.source, input.assumption_date, input.notes ?? null, input.supersedes_id ?? null, userId]);
    const versionId = version.rows[0]!.id;
    for (const rate of input.rates) {
      await client.query(`
        INSERT INTO public.margin_rates
          (rate_version_id, rate_code, category, scope_type, scope_ref, amount, unit, source_ref)
        VALUES ($1::uuid,$2,$3,$4,$5,$6::numeric,$7,$8)
      `, [versionId, rate.rate_code, rate.category, rate.scope_type, rate.scope_ref ?? null, rate.amount, rate.unit, rate.source_ref ?? null]);
    }
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
           v.source, v.assumption_date::text, v.notes, v.supersedes_id::text, v.created_by, v.created_at::text,
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

export async function repoCreateSnapshot(calculation: MarginCalculation, input: MarginCalculationInput, userId: number): Promise<{ id: string; created_at: string }> {
  const result = await pool.query<{ id: string; created_at: string }>(`
    INSERT INTO public.margin_recalculations
      (scope_type, scope_ref, basis, as_of, formula_version, calculation_hash, input_snapshot, result_snapshot, created_by)
    VALUES ($1,$2,$3,$4::date,$5,$6,$7::jsonb,$8::jsonb,$9)
    RETURNING id::text, created_at::text
  `, [calculation.scope.type, calculation.scope.ref, calculation.basis, calculation.as_of, calculation.formula_version,
      calculation.calculation_hash, JSON.stringify(input), JSON.stringify(calculation), userId]);
  return result.rows[0]!;
}
