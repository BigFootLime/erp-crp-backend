import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { repoCenter as repoMetrologyCenter } from "../../metrologie/repository/metrology-registry.repository";
import {
  assessSpcReadiness,
  computeQualityDecisionMetrics,
  type QualityDecisionMetric,
  type QualityMetricReliability,
} from "../domain/quality-intelligence";
import {
  decideQualityReceipt,
  assertOptimisticVersion,
  normalizeQualityIdempotencyKey,
  qualityRequestHash,
} from "../domain/quality-policy";
import type {
  CreateQualityCostBodyDTO,
  AssignQualityCauseBodyDTO,
  QualityIntelligenceQueryDTO,
} from "../validators/quality-360.validators";
import type { QualityActor } from "./quality-360.repository";

type AggregateRow = {
  first_pass_conforming_qty: string | null;
  first_pass_controlled_qty: string | null;
  first_pass_missing_data: string;
  defect_qty: string | null;
  controlled_qty: string | null;
  controls_missing_quantities: string;
  freshest_control_at: string | null;
};

type ClosureRow = { duration_days: string; closed_at: string };
type CostRow = { category: string; amount: string; currency: string; freshest_cost_at: string };
type ParetoRow = { cause_code: string; label: string; count: string; defect_qty: string | null };
type TrendRow = {
  week_start: string;
  controlled_qty: string;
  conforming_qty: string;
  missing_qty: string;
};
type CapaRow = {
  id: string;
  non_conformity_id: string;
  non_conformity_reference: string;
  description: string;
  responsible_user_id: number;
  due_date: string | null;
  status: string;
  priority: string;
  mandatory: boolean;
  evidence_required: boolean;
  evidence_count: string;
};
type SpcPolicyRow = {
  id: string;
  code: string;
  version: number;
  characteristic_key: string;
  expected_unit: string;
  sampling_rule: string;
  subgroup_size: number;
  min_subgroups: number;
  cadence_minutes: number;
  observed_subgroups: string;
  observed_units: string[] | null;
  control_times: string[] | null;
};

function numberOf(value: string | number | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableAmount(rows: CostRow[], categories: string[]): number | null {
  const selected = rows.filter((row) => categories.includes(row.category));
  return selected.length > 0 ? selected.reduce((sum, row) => sum + numberOf(row.amount), 0) : null;
}

function cadenceCoverage(times: string[], cadenceMinutes: number): number | null {
  if (times.length < 2 || cadenceMinutes <= 0) return null;
  const expectedMs = cadenceMinutes * 60_000;
  let valid = 0;
  let total = 0;
  for (let index = 1; index < times.length; index += 1) {
    const previous = Date.parse(times[index - 1]!);
    const current = Date.parse(times[index]!);
    if (!Number.isFinite(previous) || !Number.isFinite(current) || current <= previous) continue;
    total += 1;
    const ratio = (current - previous) / expectedMs;
    if (ratio >= 0.5 && ratio <= 1.5) valid += 1;
  }
  return total > 0 ? valid / total : null;
}

export type QualityIntelligenceDTO = {
  period: { from: string; to: string; timezone: "UTC" };
  generated_at: string;
  freshness: { latest_source_at: string | null; age_seconds: number | null };
  source: string[];
  reliability: QualityMetricReliability;
  metrics: QualityDecisionMetric[];
  pareto: Array<{ cause_code: string; label: string; count: number; defect_qty: number | null }>;
  trend: Array<{
    week_start: string;
    controlled_qty: number | null;
    conforming_qty: number | null;
    fpy_percent: number | null;
    reliability: QualityMetricReliability;
  }>;
  capa_queue: Array<{
    id: string;
    non_conformity_id: string;
    non_conformity_reference: string;
    description: string;
    responsible_user_id: number;
    due_date: string | null;
    status: string;
    priority: string;
    mandatory: boolean;
    closure_evidence: "NOT_REQUIRED" | "MISSING" | "AVAILABLE";
  }>;
  spc: Array<{
    policy_id: string;
    code: string;
    version: number;
    characteristic_key: string;
    enabled: boolean;
    reliability: QualityMetricReliability;
    missing: string[];
  }>;
  metrology: Awaited<ReturnType<typeof repoMetrologyCenter>>;
};

export async function repoQualityIntelligence(
  query: QualityIntelligenceQueryDTO
): Promise<QualityIntelligenceDTO> {
  const from = `${query.from}T00:00:00.000Z`;
  const toExclusiveDate = new Date(`${query.to}T00:00:00.000Z`);
  toExclusiveDate.setUTCDate(toExclusiveDate.getUTCDate() + 1);
  const toExclusive = toExclusiveDate.toISOString();
  const range = [from, toExclusive];

  const [aggregateRes, closureRes, costRes, paretoRes, trendRes, capaRes, spcRes, metrology] = await Promise.all([
    pool.query<AggregateRow>(
      `
        WITH finalized AS (
          SELECT qc.*,
                 row_number() OVER (
                   PARTITION BY COALESCE(qc.source_type || ':' || qc.source_id, 'LEGACY:' || qc.id::text)
                   ORDER BY qc.validation_date ASC, qc.created_at ASC, qc.id ASC
                 ) AS pass_no
          FROM public.quality_control qc
          WHERE qc.validation_date >= $1::timestamptz
            AND qc.validation_date < $2::timestamptz
        ), first_pass AS (
          SELECT * FROM finalized WHERE pass_no = 1
        )
        SELECT
          SUM(qty_conforming) FILTER (WHERE qty_controlled > 0)::text AS first_pass_conforming_qty,
          SUM(qty_controlled) FILTER (WHERE qty_controlled > 0)::text AS first_pass_controlled_qty,
          COUNT(*) FILTER (
            WHERE source_type IS NULL OR source_id IS NULL OR qty_controlled <= 0 OR qty_conforming IS NULL
          )::text AS first_pass_missing_data,
          SUM(GREATEST(qty_controlled - qty_conforming, 0)) FILTER (WHERE qty_controlled > 0)::text AS defect_qty,
          SUM(qty_controlled) FILTER (WHERE qty_controlled > 0)::text AS controlled_qty,
          COUNT(*) FILTER (WHERE qty_controlled <= 0 OR qty_conforming IS NULL)::text AS controls_missing_quantities,
          MAX(validation_date)::text AS freshest_control_at
        FROM first_pass
      `,
      range
    ),
    pool.query<ClosureRow>(
      `
        SELECT (EXTRACT(EPOCH FROM (closed_at - detection_date)) / 86400.0)::text AS duration_days,
               closed_at::text AS closed_at
        FROM public.non_conformity
        WHERE closed_at >= $1::timestamptz AND closed_at < $2::timestamptz
          AND closed_at >= detection_date
      `,
      range
    ),
    pool.query<CostRow>(
      `
        SELECT category, SUM(amount)::text AS amount, currency, MAX(created_at)::text AS freshest_cost_at
        FROM public.quality_cost_entry
        WHERE occurred_on >= $1::date AND occurred_on < $2::date
        GROUP BY category, currency
      `,
      [query.from, toExclusive.slice(0, 10)]
    ),
    pool.query<ParetoRow>(
      `
        SELECT nc.cause_code, cc.label, COUNT(*)::text AS count, SUM(nc.qty)::text AS defect_qty
        FROM public.non_conformity nc
        JOIN public.quality_cause_catalog cc ON cc.code = nc.cause_code
        WHERE nc.detection_date >= $1::timestamptz AND nc.detection_date < $2::timestamptz
          AND nc.cause_code IS NOT NULL
        GROUP BY nc.cause_code, cc.label
        ORDER BY COUNT(*) DESC, nc.cause_code ASC
        LIMIT 20
      `,
      range
    ),
    pool.query<TrendRow>(
      `
        WITH finalized AS (
          SELECT qc.*,
                 row_number() OVER (
                   PARTITION BY COALESCE(qc.source_type || ':' || qc.source_id, 'LEGACY:' || qc.id::text)
                   ORDER BY qc.validation_date ASC, qc.created_at ASC, qc.id ASC
                 ) AS pass_no
          FROM public.quality_control qc
          WHERE qc.validation_date >= $1::timestamptz AND qc.validation_date < $2::timestamptz
        ), first_pass AS (
          SELECT * FROM finalized WHERE pass_no = 1
        )
        SELECT date_trunc('week', validation_date AT TIME ZONE 'UTC')::date::text AS week_start,
               SUM(qty_controlled) FILTER (WHERE qty_controlled > 0)::text AS controlled_qty,
               SUM(qty_conforming) FILTER (WHERE qty_controlled > 0)::text AS conforming_qty,
               COUNT(*) FILTER (WHERE qty_controlled <= 0 OR qty_conforming IS NULL)::text AS missing_qty
        FROM first_pass
        GROUP BY 1 ORDER BY 1
      `,
      range
    ),
    pool.query<CapaRow>(
      `
        SELECT a.id::text, a.non_conformity_id::text, nc.reference AS non_conformity_reference,
               a.description, a.responsible_user_id, a.due_date::text, a.status::text,
               a.priority, a.mandatory, a.evidence_required,
               COUNT(d.id)::text AS evidence_count
        FROM public.quality_action a
        JOIN public.non_conformity nc ON nc.id = a.non_conformity_id
        LEFT JOIN public.quality_documents d
          ON d.entity_type = 'ACTION' AND d.entity_id = a.id AND d.removed_at IS NULL
        WHERE a.status <> 'VERIFIED'
        GROUP BY a.id, nc.reference
        ORDER BY
          CASE a.priority WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END,
          a.due_date ASC NULLS LAST, a.created_at ASC
        LIMIT 100
      `
    ),
    pool.query<SpcPolicyRow>(
      `
        WITH observed AS (
          SELECT p.id AS policy_id,
                 CASE WHEN COUNT(qcp.id) >= p.subgroup_size THEN qc.id ELSE NULL END AS control_id,
                 CASE WHEN COUNT(qcp.id) >= p.subgroup_size THEN MIN(qcp.measured_at) ELSE NULL END AS measured_at,
                 array_remove(array_agg(DISTINCT qcp.unit), NULL) AS units
          FROM public.quality_spc_policy p
          LEFT JOIN public.quality_control qc
            ON qc.validation_date >= $1::timestamptz
           AND qc.validation_date < $2::timestamptz
           AND qc.validation_date >= p.effective_from
           AND (p.effective_to IS NULL OR qc.validation_date <= p.effective_to)
          LEFT JOIN public.quality_control_points qcp
            ON qcp.quality_control_id = qc.id AND qcp.characteristic_key = p.characteristic_key
          WHERE (p.active OR p.retired_at IS NOT NULL) AND p.effective_from < $2::timestamptz
            AND (p.effective_to IS NULL OR p.effective_to >= $1::timestamptz)
          GROUP BY p.id, qc.id
        )
        SELECT p.id::text, p.code, p.version, p.characteristic_key, p.expected_unit,
               p.sampling_rule, p.subgroup_size, p.min_subgroups, p.cadence_minutes,
               COUNT(DISTINCT o.control_id)::text AS observed_subgroups,
               COALESCE(array_agg(DISTINCT unit_value) FILTER (WHERE unit_value IS NOT NULL), ARRAY[]::text[]) AS observed_units,
               COALESCE(array_agg(o.measured_at::text ORDER BY o.measured_at) FILTER (WHERE o.measured_at IS NOT NULL), ARRAY[]::text[]) AS control_times
        FROM public.quality_spc_policy p
        LEFT JOIN observed o ON o.policy_id = p.id
        LEFT JOIN LATERAL unnest(COALESCE(o.units, ARRAY[]::text[])) unit_value ON TRUE
        WHERE (p.active OR p.retired_at IS NOT NULL) AND p.effective_from < $2::timestamptz
          AND (p.effective_to IS NULL OR p.effective_to >= $1::timestamptz)
        GROUP BY p.id
        ORDER BY p.code, p.version DESC
        LIMIT 50
      `,
      range
    ),
    repoMetrologyCenter({ site: null, categorieCode: null, horizonDays: query.horizon_days }),
  ]);

  const aggregate = aggregateRes.rows[0] ?? {
    first_pass_conforming_qty: null,
    first_pass_controlled_qty: null,
    first_pass_missing_data: "0",
    defect_qty: null,
    controlled_qty: null,
    controls_missing_quantities: "0",
    freshest_control_at: null,
  };
  const currencies = [...new Set(costRes.rows.map((row) => row.currency))];
  const costCurrency = currencies.length === 1 ? currencies[0]! : null;
  const metrics = computeQualityDecisionMetrics({
    firstPassConformingQty: numberOf(aggregate.first_pass_conforming_qty),
    firstPassControlledQty: numberOf(aggregate.first_pass_controlled_qty),
    firstPassMissingData: numberOf(aggregate.first_pass_missing_data),
    defectQty: numberOf(aggregate.defect_qty),
    controlledQty: numberOf(aggregate.controlled_qty),
    controlsMissingQuantities: numberOf(aggregate.controls_missing_quantities),
    closureDurationsDays: closureRes.rows.map((row) => numberOf(row.duration_days)),
    scrapCost: nullableAmount(costRes.rows, ["SCRAP"]),
    reworkCost: nullableAmount(costRes.rows, ["REWORK"]),
    otherPoorQualityCost: nullableAmount(costRes.rows, ["SORTING", "CONTAINMENT", "RETURN", "OTHER"]),
    costCurrency,
    costCurrencyCount: currencies.length,
  });

  const freshnessCandidates = [
    aggregate.freshest_control_at,
    ...closureRes.rows.map((row) => row.closed_at),
    ...costRes.rows.map((row) => row.freshest_cost_at),
  ].filter((value): value is string => Boolean(value));
  const latestSourceMs = freshnessCandidates.reduce((latest, value) => Math.max(latest, Date.parse(value)), 0);
  const generatedAt = new Date();

  const reliability: QualityMetricReliability = metrics.every((metric) => metric.reliability === "CONFIRMED")
    ? "CONFIRMED"
    : metrics.some((metric) => metric.reliability !== "UNAVAILABLE")
      ? "PARTIAL"
      : "UNAVAILABLE";

  return {
    period: { from: query.from, to: query.to, timezone: "UTC" },
    generated_at: generatedAt.toISOString(),
    freshness: {
      latest_source_at: latestSourceMs > 0 ? new Date(latestSourceMs).toISOString() : null,
      age_seconds: latestSourceMs > 0 ? Math.max(0, Math.round((generatedAt.getTime() - latestSourceMs) / 1000)) : null,
    },
    source: [
      "quality_control",
      "non_conformity",
      "quality_action",
      "quality_documents",
      "quality_cost_entry",
      "quality_spc_policy",
      "metrologie_equipements",
      "metrologie_plan_version",
    ],
    reliability,
    metrics,
    pareto: paretoRes.rows.map((row) => ({
      cause_code: row.cause_code,
      label: row.label,
      count: numberOf(row.count),
      defect_qty: row.defect_qty === null ? null : numberOf(row.defect_qty),
    })),
    trend: trendRes.rows.map((row) => {
      const controlled = numberOf(row.controlled_qty);
      const conforming = numberOf(row.conforming_qty);
      const missing = numberOf(row.missing_qty);
      return {
        week_start: row.week_start,
        controlled_qty: controlled > 0 ? controlled : null,
        conforming_qty: controlled > 0 ? conforming : null,
        fpy_percent: controlled > 0 ? Math.round((conforming / controlled) * 10_000) / 100 : null,
        reliability: controlled <= 0 ? "UNAVAILABLE" : missing > 0 ? "PARTIAL" : "CONFIRMED",
      };
    }),
    capa_queue: capaRes.rows.map((row) => ({
      id: row.id,
      non_conformity_id: row.non_conformity_id,
      non_conformity_reference: row.non_conformity_reference,
      description: row.description,
      responsible_user_id: row.responsible_user_id,
      due_date: row.due_date,
      status: row.status,
      priority: row.priority,
      mandatory: row.mandatory,
      closure_evidence: !row.evidence_required
        ? "NOT_REQUIRED"
        : numberOf(row.evidence_count) > 0
          ? "AVAILABLE"
          : "MISSING",
    })),
    spc: spcRes.rows.map((row) => {
      const readiness = assessSpcReadiness({
        policyActive: true,
        samplingRule: row.sampling_rule,
        expectedUnit: row.expected_unit,
        cadenceMinutes: row.cadence_minutes,
        subgroupSize: row.subgroup_size,
        minSubgroups: row.min_subgroups,
        observedSubgroups: numberOf(row.observed_subgroups),
        observedUnits: row.observed_units ?? [],
        cadenceCoverageRatio: cadenceCoverage(row.control_times ?? [], row.cadence_minutes),
      });
      return {
        policy_id: row.id,
        code: row.code,
        version: row.version,
        characteristic_key: row.characteristic_key,
        ...readiness,
      };
    }),
    metrology,
  };
}

export type QualityCostEntryDTO = CreateQualityCostBodyDTO & {
  id: string;
  created_at: string;
  created_by: number;
};

export async function repoCreateQualityCost(params: {
  body: CreateQualityCostBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null;
}): Promise<QualityCostEntryDTO> {
  const key = normalizeQualityIdempotencyKey(params.idempotencyKey);
  const requestHash = qualityRequestHash("QUALITY_COST_CREATE", params.body);
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
      const existing = await tx.query<{ id: string; request_hash: string }>(
        `SELECT id::text, request_hash FROM public.quality_cost_entry
         WHERE created_by = $1 AND idempotency_key = $2 FOR UPDATE`,
        [params.actor.user_id, key]
      );
      const receipt = decideQualityReceipt(existing.rows[0]?.request_hash, requestHash);
      if (receipt === "CONFLICT") {
        throw new HttpError(409, "QUALITY_COST_IDEMPOTENCY_CONFLICT", "Cette clé a déjà servi pour un autre coût qualité.");
      }
      if (receipt === "REPLAY") {
        const replay = await tx.query<QualityCostEntryDTO>(
          `SELECT id::text, non_conformity_id::text, category, amount::float8 AS amount,
                  currency, occurred_on::text, source_type, source_id,
                  evidence_document_id::text, note, created_at::text, created_by
           FROM public.quality_cost_entry WHERE id = $1::uuid`,
          [existing.rows[0]!.id]
        );
        return replay.rows[0]!;
      }

      const inserted = await tx.query<QualityCostEntryDTO>(
        `
          INSERT INTO public.quality_cost_entry (
            non_conformity_id, category, amount, currency, occurred_on,
            source_type, source_id, evidence_document_id, note,
            idempotency_key, request_hash, created_by
          ) VALUES ($1::uuid,$2,$3,$4,$5::date,$6,$7,$8::uuid,$9,$10,$11,$12)
          RETURNING id::text, non_conformity_id::text, category, amount::float8 AS amount,
                    currency, occurred_on::text, source_type, source_id,
                    evidence_document_id::text, note, created_at::text, created_by
        `,
        [
          params.body.non_conformity_id,
          params.body.category,
          params.body.amount,
          params.body.currency,
          params.body.occurred_on,
          params.body.source_type,
          params.body.source_id,
          params.body.evidence_document_id ?? null,
          params.body.note,
          key,
          requestHash,
          params.actor.user_id,
        ]
      );
      const result = inserted.rows[0];
      if (!result) throw new Error("QUALITY_COST_INSERT_FAILED");
      await repoInsertAuditLog({
        user_id: params.actor.user_id,
        body: {
          event_type: "ACTION",
          action: "qualite.cost.create",
          page_key: params.actor.page_key,
          entity_type: "quality_cost_entry",
          entity_id: result.id,
          path: params.actor.path,
          client_session_id: params.actor.client_session_id,
          details: {
            non_conformity_id: params.body.non_conformity_id,
            category: params.body.category,
            currency: params.body.currency,
            source_type: params.body.source_type,
          },
        },
        ip: params.actor.ip,
        user_agent: params.actor.user_agent,
        device_type: params.actor.device_type,
        os: params.actor.os,
        browser: params.actor.browser,
        tx,
      });
      return result;
  });
}

export async function repoAssignQualityCause(params: {
  id: string;
  body: AssignQualityCauseBodyDTO;
  actor: QualityActor;
}): Promise<{ id: string; cause_code: string; updated_at: string }> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, async (tx) => {
      const currentRes = await tx.query<{ id: string; cause_code: string | null; updated_at: string }>(
        `SELECT id::text, cause_code, updated_at::text FROM public.non_conformity
         WHERE id = $1::uuid FOR UPDATE`,
        [params.id]
      );
      const current = currentRes.rows[0];
      if (!current) throw new HttpError(404, "NOT_FOUND", "Non-conformité introuvable.");
      if (current.cause_code === params.body.cause_code) {
        return { id: current.id, cause_code: current.cause_code, updated_at: current.updated_at };
      }
      assertOptimisticVersion({ expectedUpdatedAt: params.body.expected_updated_at, currentUpdatedAt: current.updated_at });
      const cause = await tx.query<{ code: string }>(
        `SELECT code FROM public.quality_cause_catalog WHERE code = $1 AND active`,
        [params.body.cause_code]
      );
      if (!cause.rows[0]) {
        throw new HttpError(422, "QUALITY_CAUSE_UNKNOWN", "La cause structurée est inconnue ou inactive.");
      }
      const updated = await tx.query<{ id: string; cause_code: string; updated_at: string }>(
        `UPDATE public.non_conformity
         SET cause_code = $2, updated_at = now(), updated_by = $3
         WHERE id = $1::uuid
         RETURNING id::text, cause_code, updated_at::text`,
        [params.id, params.body.cause_code, params.actor.user_id]
      );
      const result = updated.rows[0]!;
      await tx.query(
        `INSERT INTO public.quality_event_log (
           entity_type, entity_id, event_type, old_values, new_values, user_id,
           correlation_id, rule_code, reason, request_id, source
         )
         VALUES ('NON_CONFORMITY', $1::uuid, 'CAUSE_ASSIGNED', $2::jsonb, $3::jsonb, $4,
                 $1::uuid, 'QUALITY_STRUCTURED_CAUSE_SOL22', $5, $6, 'api')`,
        [
          params.id,
          JSON.stringify({ cause_code: current.cause_code }),
          JSON.stringify({ cause_code: result.cause_code }),
          params.actor.user_id,
          params.body.reason,
          params.actor.request_id,
        ]
      );
      await repoInsertAuditLog({
        user_id: params.actor.user_id,
        body: {
          event_type: "ACTION",
          action: "qualite.nc.cause.assign",
          page_key: params.actor.page_key,
          entity_type: "non_conformity",
          entity_id: params.id,
          path: params.actor.path,
          client_session_id: params.actor.client_session_id,
          details: { from: current.cause_code, to: result.cause_code, reason: params.body.reason },
        },
        ip: params.actor.ip,
        user_agent: params.actor.user_agent,
        device_type: params.actor.device_type,
        os: params.actor.os,
        browser: params.actor.browser,
        tx,
      });
      return result;
  });
}
