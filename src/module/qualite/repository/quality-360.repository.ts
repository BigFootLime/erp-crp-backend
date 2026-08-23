// Repository Qualité 360 (#228).
//
// Toutes les décisions passent par une transaction, un verrou optimiste, un
// journal append-only et — dès qu'un effet est transactionnel — un reçu
// d'idempotence. Aucun code métier n'est calculé côté client, aucun MAX()+1.

import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { generateTransactionalBusinessCode } from "../../../shared/codes/code-generator.service";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";

import {
  assertDerogationApprovalSeparation,
  assertDerogationTransition,
  assertManualVerdictOverride,
  assertNcClosureAllowed,
  assertNcTransition,
  assertOptimisticVersion,
  assertPlanContentMutable,
  assertPlanTransition,
  assertPreviewFresh,
  assertReleaseSeparation,
  decideQualityReceipt,
  executionStatusForVerdict,
  legacyResultToVerdict,
  normalizeQualityIdempotencyKey,
  qualityRequestHash,
  qualitySha256,
  verdictToLegacyResult,
  type QualityDerogationStatus,
  type QualityNcStatus,
  type QualityPlanStatus,
  type QualityVerdict,
} from "../domain/quality-policy";
import {
  assertCharacteristicSpec,
  assertNoApplicabilityOverlap,
  assertSnapshotIntegrity,
  buildPlanSnapshot,
  characteristicsFromSnapshot,
  computeExecutionVerdict,
  evaluateSample,
  requiredSampleCount,
  resolveCharacteristicBounds,
  selectApplicablePlan,
  type ApplicabilityContext,
  type PlanCandidate,
  type QualityCharacteristicSpec,
  type QualitySampleValue,
} from "../domain/quality-plan";
import {
  assertQuantityLedger,
  assertSourceRef,
  derogationStatusAfterConsumption,
  evaluateDerogationUsage,
  evaluateQualityEligibility,
  evaluateReleaseRequest,
  releasableQty,
  type DerogationState,
  type EligibilityTarget,
  type QualityEligibilityPurpose,
  type QuantityLedger,
} from "../domain/quality-release";
// #229 — Source de vérité unique de l'éligibilité d'un instrument : le module
// Métrologie. Le module Qualité la consomme, il ne la ré-implémente pas.
import { repoBuildInstrumentSnapshot } from "../../metrologie/repository/metrology-registry.repository";
import type {
  MetrologyInstrumentSnapshot,
  MetrologyUsageRequirement,
} from "../../metrologie/domain/metrology-eligibility";
import type {
  ConsumeDerogationBodyDTO,
  CreateDerogationBodyDTO,
  CreateExecutionBodyDTO,
  CreatePlanBodyDTO,
  DecideExecutionBodyDTO,
  DerogationTransitionBodyDTO,
  EligibilityQueryDTO,
  ExecutionPreviewBodyDTO,
  ListDerogationsQueryDTO,
  ListExecutionsQueryDTO,
  ListPlansQueryDTO,
  NcTransitionBodyDTO,
  PlanApplicabilityQueryDTO,
  PlanTransitionBodyDTO,
  RecordMeasurementsBodyDTO,
  UpdatePlanBodyDTO,
  UpsertAnalysisBodyDTO,
} from "../validators/quality-360.validators";
import type { AuditContext } from "./qualite.repository";

type DbQueryer = Pick<PoolClient, "query">;

export type QualityActor = AuditContext & { role: string | null; request_id: string | null };

/* ========================================================================== */
/* Helpers transversaux                                                       */
/* ========================================================================== */

async function insertAuditLog(
  tx: DbQueryer,
  actor: QualityActor,
  entry: { action: string; entity_type: string; entity_id: string; details?: Record<string, unknown> }
): Promise<void> {
  await repoInsertAuditLog({
    user_id: actor.user_id,
    body: {
      event_type: "ACTION",
      action: entry.action,
      page_key: actor.page_key,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      path: actor.path,
      client_session_id: actor.client_session_id,
      details: entry.details ?? null,
    },
    ip: actor.ip,
    user_agent: actor.user_agent,
    device_type: actor.device_type,
    os: actor.os,
    browser: actor.browser,
    tx,
  });
}

/**
 * Journal métier append-only. Écrit dans la MÊME transaction que la décision :
 * une décision sans trace est impossible.
 */
async function insertQualityEvent(
  tx: DbQueryer,
  params: {
    entity_type: "CONTROL" | "NON_CONFORMITY" | "ACTION" | "PLAN" | "DEROGATION" | "RELEASE";
    entity_id: string;
    event_type: string;
    actor: QualityActor;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
    correlation_id: string;
    idempotency_key?: string | null;
    rule_code?: string | null;
    reason?: string | null;
  }
): Promise<void> {
  const inserted = await tx.query<{ id: string; created_at: string }>(
    `
      INSERT INTO public.quality_event_log (
        entity_type, entity_id, event_type, old_values, new_values, user_id,
        correlation_id, idempotency_key, rule_code, reason, request_id, source
      )
      VALUES (
        $1::public.quality_entity_type, $2::uuid, $3, $4::jsonb, $5::jsonb, $6,
        $7::uuid, $8, $9, $10, $11, 'api'
      )
      RETURNING id::text AS id, created_at::text AS created_at
    `,
    [
      params.entity_type,
      params.entity_id,
      params.event_type,
      params.old_values ? JSON.stringify(params.old_values) : null,
      params.new_values ? JSON.stringify(params.new_values) : null,
      params.actor.user_id,
      params.correlation_id,
      params.idempotency_key ?? null,
      params.rule_code ?? null,
      params.reason ?? null,
      params.actor.request_id,
    ]
  );
  const event = inserted.rows[0];
  if (!event) throw new Error("QUALITY_360_EVENT_INSERT_FAILED");
  if (params.entity_type === "NON_CONFORMITY" || params.entity_type === "ACTION") {
    await enqueueQuality360EntityChanged(tx, {
      entityType: params.entity_type,
      entityId: params.entity_id,
      eventId: event.id,
      eventType: params.event_type,
      occurredAt: event.created_at,
    });
  }
}

export async function enqueueQuality360EntityChanged(
  tx: DbQueryer,
  params: {
    entityType: "NON_CONFORMITY" | "ACTION";
    entityId: string;
    eventId: string;
    eventType: string;
    occurredAt: string;
  }
): Promise<void> {
  const normalized = params.eventType.toUpperCase();
  const action = normalized === "CREATE"
    ? "created"
    : normalized.includes("DELETE") || normalized.includes("REMOVE")
      ? "deleted"
      : normalized.includes("TRANSITION")
          || normalized.includes("STATUS")
          || normalized.includes("CLOSE")
        ? "status_changed"
        : "updated";
  const isNc = params.entityType === "NON_CONFORMITY";
  await enqueueEntityChanged(tx, {
    entityType: isNc ? "NCR" : "CAPA",
    entityId: params.entityId,
    action,
    module: "qualite",
    at: params.occurredAt,
    invalidateKeys: isNc
      ? [
          "qualite:non-conformities",
          "qualite:kpis",
          "qualite:dashboard",
          "qualite:controls",
          `qualite:non-conformity:${params.entityId}`,
          `qualite:non-conformity:${params.entityId}:dispositions`,
        ]
      : ["qualite:actions", `qualite:action:${params.entityId}`],
  }, { deduplicationKey: `quality-360-event:${params.eventId}` });
}

async function acquireIdempotency(params: {
  client: PoolClient;
  actor: QualityActor;
  idempotencyKeyRaw: string | null | undefined;
  commandType: string;
  requestPayload: unknown;
}): Promise<{ idempotencyKey: string; requestHash: string; replay: Record<string, unknown> | null }> {
  const idempotencyKey = normalizeQualityIdempotencyKey(params.idempotencyKeyRaw);
  const requestHash = qualityRequestHash(params.commandType, params.requestPayload);
  await params.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `quality:${params.actor.user_id}:${idempotencyKey}`,
  ]);
  const existing = await params.client.query<{ request_hash: string; result_payload: Record<string, unknown> }>(
    `
      SELECT request_hash, result_payload
      FROM public.quality_command_receipts
      WHERE actor_user_id = $1 AND idempotency_key = $2
      LIMIT 1
    `,
    [params.actor.user_id, idempotencyKey]
  );
  const receipt = existing.rows[0] ?? null;
  const decision = decideQualityReceipt(receipt?.request_hash, requestHash);
  if (decision === "CONFLICT") {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Cette Idempotency-Key a déjà été utilisée avec un autre contenu."
    );
  }
  return { idempotencyKey, requestHash, replay: decision === "REPLAY" ? receipt?.result_payload ?? null : null };
}

async function saveReceipt(params: {
  client: PoolClient;
  actor: QualityActor;
  idempotencyKey: string;
  requestHash: string;
  commandType: string;
  aggregateType: "PLAN" | "CONTROL" | "NON_CONFORMITY" | "ACTION" | "DEROGATION" | "RELEASE" | "DISPOSITION";
  aggregateId: string;
  requestPayload: unknown;
  resultPayload: unknown;
  correlationId: string;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO public.quality_command_receipts (
        actor_user_id, idempotency_key, request_hash, command_type,
        aggregate_type, aggregate_id, request_payload, result_payload, correlation_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::uuid)
    `,
    [
      params.actor.user_id,
      params.idempotencyKey,
      params.requestHash,
      params.commandType,
      params.aggregateType,
      params.aggregateId,
      JSON.stringify(params.requestPayload ?? null),
      JSON.stringify(params.resultPayload ?? null),
      params.correlationId,
    ]
  );
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  return withRealtimeOutboxTransaction(client, fn);
}

function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sortDirection(dir: "asc" | "desc"): "ASC" | "DESC" {
  return dir === "asc" ? "ASC" : "DESC";
}

// #229 — La lecture du réglage `metrologie.block_on_overdue_critical` a migré
// dans `module/metrologie/repository/metrology-shared.repository.ts`
// (`loadMetrologyPolicy`). Elle est appliquée à l'instrument réellement utilisé,
// jamais en verrou global : garder une seconde lecture ici ferait diverger deux
// interprétations du même réglage.

/* ========================================================================== */
/* Plans de contrôle                                                          */
/* ========================================================================== */

export type QualityPlanRow = {
  id: string;
  code: string;
  version: number;
  label: string;
  status: QualityPlanStatus;
  trigger_type: string;
  article_id: string | null;
  piece_technique_id: string | null;
  piece_version_id: string | null;
  famille_id: string | null;
  operation_code: string | null;
  fournisseur_id: string | null;
  sampling_rule: string;
  sampling_value: string | number | null;
  sampling_justification: string | null;
  owner_user_id: number | null;
  revision_reason: string | null;
  effective_from: string | null;
  effective_to: string | null;
  supersedes_plan_id: string | null;
  published_at: string | null;
  published_by: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
  characteristic_count?: number;
};

const PLAN_COLUMNS = `
  p.id, p.code, p.version, p.label, p.status, p.trigger_type,
  p.article_id, p.piece_technique_id, p.piece_version_id, p.famille_id,
  p.operation_code, p.fournisseur_id,
  p.sampling_rule, p.sampling_value, p.sampling_justification,
  p.owner_user_id, p.revision_reason, p.effective_from, p.effective_to,
  p.supersedes_plan_id, p.published_at, p.published_by, p.archived_at,
  p.created_at, p.updated_at, p.created_by, p.updated_by
`;

const PLAN_SORT_COLUMNS: Record<ListPlansQueryDTO["sortBy"], string> = {
  code: "p.code",
  version: "p.version",
  label: "p.label",
  status: "p.status",
  updated_at: "p.updated_at",
  published_at: "p.published_at",
};

export async function repoListPlans(
  filters: ListPlansQueryDTO
): Promise<{ items: QualityPlanRow[]; total: number }> {
  const where: string[] = ["TRUE"];
  const values: unknown[] = [];
  // `$?` est remplacé par l'index du paramètre ajouté : toutes les occurrences
  // partagent la même valeur, ce qui évite un placeholder orphelin.
  const push = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace(/\$\?/g, `$${values.length}`));
  };

  if (filters.q) push("(p.code ILIKE $? OR p.label ILIKE $?)", `%${filters.q}%`);
  if (filters.status) push("p.status = $?", filters.status);
  if (filters.trigger_type) push("p.trigger_type = $?", filters.trigger_type);
  if (filters.article_id) push("p.article_id = $?::uuid", filters.article_id);
  if (filters.piece_technique_id) push("p.piece_technique_id = $?::uuid", filters.piece_technique_id);
  if (filters.piece_version_id) push("p.piece_version_id = $?::uuid", filters.piece_version_id);
  if (filters.famille_id) push("p.famille_id = $?::uuid", filters.famille_id);
  if (filters.fournisseur_id) push("p.fournisseur_id = $?::uuid", filters.fournisseur_id);

  const whereSql = where.join(" AND ");

  const totalRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.quality_control_plan p WHERE ${whereSql}`,
    values
  );

  const limit = filters.pageSize;
  const offset = (filters.page - 1) * filters.pageSize;
  const itemsRes = await pool.query<QualityPlanRow>(
    `
      SELECT ${PLAN_COLUMNS},
        (SELECT COUNT(*)::int FROM public.quality_control_plan_characteristic c WHERE c.plan_id = p.id) AS characteristic_count
      FROM public.quality_control_plan p
      WHERE ${whereSql}
      ORDER BY ${PLAN_SORT_COLUMNS[filters.sortBy]} ${sortDirection(filters.sortDir)} NULLS LAST, p.code ASC, p.version DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    values
  );

  return { items: itemsRes.rows, total: totalRes.rows[0]?.total ?? 0 };
}

async function selectPlanCharacteristics(
  q: DbQueryer,
  planId: string
): Promise<QualityCharacteristicSpec[]> {
  const res = await q.query<{
    characteristic_key: string;
    position: number;
    label: string;
    characteristic_type: string;
    value_kind: string;
    unit: string | null;
    nominal: string | null;
    tolerance_min: string | null;
    tolerance_max: string | null;
    precision_digits: number | null;
    expected_boolean: boolean | null;
    allowed_values: string[] | null;
    criticality: string;
    mandatory: boolean;
    requires_instrument: boolean;
    instrument_category: string | null;
    method: string | null;
    acceptance_rule: string | null;
    sampling_rule: string;
    sampling_value: string | null;
    sampling_justification: string | null;
    trigger_type: string;
  }>(
    `
      SELECT characteristic_key, position, label, characteristic_type, value_kind, unit,
             nominal, tolerance_min, tolerance_max, precision_digits, expected_boolean,
             allowed_values, criticality, mandatory, requires_instrument, instrument_category,
             method, acceptance_rule, sampling_rule, sampling_value, sampling_justification, trigger_type
      FROM public.quality_control_plan_characteristic
      WHERE plan_id = $1::uuid
      ORDER BY position ASC, characteristic_key ASC
    `,
    [planId]
  );

  return res.rows.map((row) => ({
    key: row.characteristic_key,
    position: row.position,
    label: row.label,
    characteristic_type: row.characteristic_type as QualityCharacteristicSpec["characteristic_type"],
    value_kind: row.value_kind as QualityCharacteristicSpec["value_kind"],
    unit: row.unit,
    nominal: row.nominal === null ? null : Number(row.nominal),
    tolerance_min: row.tolerance_min === null ? null : Number(row.tolerance_min),
    tolerance_max: row.tolerance_max === null ? null : Number(row.tolerance_max),
    precision: row.precision_digits,
    expected_boolean: row.expected_boolean,
    allowed_values: row.allowed_values,
    criticality: row.criticality as QualityCharacteristicSpec["criticality"],
    mandatory: row.mandatory,
    requires_instrument: row.requires_instrument,
    instrument_category: row.instrument_category,
    method: row.method,
    acceptance_rule: row.acceptance_rule,
    sampling: {
      rule: row.sampling_rule as QualityCharacteristicSpec["sampling"]["rule"],
      value: row.sampling_value === null ? null : Number(row.sampling_value),
      justification: row.sampling_justification,
    },
    trigger: row.trigger_type as QualityCharacteristicSpec["trigger"],
  }));
}

async function selectPlanRow(q: DbQueryer, id: string, forUpdate = false): Promise<QualityPlanRow | null> {
  const res = await q.query<QualityPlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM public.quality_control_plan p WHERE p.id = $1::uuid ${forUpdate ? "FOR UPDATE" : ""}`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function repoGetPlan(
  id: string
): Promise<{ plan: QualityPlanRow; characteristics: QualityCharacteristicSpec[] } | null> {
  const plan = await selectPlanRow(pool, id);
  if (!plan) return null;
  const characteristics = await selectPlanCharacteristics(pool, id);
  return { plan, characteristics };
}

async function replacePlanCharacteristics(
  tx: DbQueryer,
  planId: string,
  characteristics: readonly QualityCharacteristicSpec[]
): Promise<void> {
  const keys = new Set<string>();
  const positions = new Set<number>();
  for (const spec of characteristics) {
    assertCharacteristicSpec(spec);
    if (keys.has(spec.key)) {
      throw new HttpError(422, "QUALITY_CHARACTERISTIC_KEY_DUPLICATE", `Clé dupliquée : ${spec.key}.`);
    }
    if (positions.has(spec.position)) {
      throw new HttpError(
        422,
        "QUALITY_CHARACTERISTIC_POSITION_DUPLICATE",
        `Position dupliquée : ${spec.position}.`
      );
    }
    keys.add(spec.key);
    positions.add(spec.position);
  }

  await tx.query(`DELETE FROM public.quality_control_plan_characteristic WHERE plan_id = $1::uuid`, [planId]);

  for (const spec of characteristics) {
    await tx.query(
      `
        INSERT INTO public.quality_control_plan_characteristic (
          plan_id, characteristic_key, position, label, characteristic_type, value_kind,
          unit, nominal, tolerance_min, tolerance_max, precision_digits, expected_boolean,
          allowed_values, criticality, mandatory, requires_instrument, instrument_category,
          method, acceptance_rule, sampling_rule, sampling_value, sampling_justification, trigger_type
        )
        VALUES (
          $1::uuid, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13::jsonb, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23
        )
      `,
      [
        planId,
        spec.key,
        spec.position,
        spec.label,
        spec.characteristic_type,
        spec.value_kind,
        spec.unit,
        spec.nominal,
        spec.tolerance_min,
        spec.tolerance_max,
        spec.precision,
        spec.expected_boolean,
        spec.allowed_values ? JSON.stringify(spec.allowed_values) : null,
        spec.criticality,
        spec.mandatory,
        spec.requires_instrument,
        spec.instrument_category,
        spec.method,
        spec.acceptance_rule,
        spec.sampling.rule,
        spec.sampling.value,
        spec.sampling.justification,
        spec.trigger,
      ]
    );
  }
}

function toSpec(input: CreatePlanBodyDTO["characteristics"][number]): QualityCharacteristicSpec {
  return {
    key: input.characteristic_key,
    position: input.position,
    label: input.label,
    characteristic_type: input.characteristic_type,
    value_kind: input.value_kind,
    unit: input.unit,
    nominal: input.nominal,
    tolerance_min: input.tolerance_min,
    tolerance_max: input.tolerance_max,
    precision: input.precision,
    expected_boolean: input.expected_boolean,
    allowed_values: input.allowed_values,
    criticality: input.criticality,
    mandatory: input.mandatory,
    requires_instrument: input.requires_instrument,
    instrument_category: input.instrument_category,
    method: input.method,
    acceptance_rule: input.acceptance_rule,
    sampling: input.sampling,
    trigger: input.trigger,
  };
}

export async function repoCreatePlan(params: {
  body: CreatePlanBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<{ plan: QualityPlanRow; characteristics: QualityCharacteristicSpec[] }> {
  return withTransaction(async (client) => {
    const idem = await acquireIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "quality.plan.create",
      requestPayload: params.body,
    });
    if (idem.replay) {
      const replayed = await repoGetPlan(String(idem.replay.plan_id));
      if (replayed) return replayed;
    }

    // Le code est serveur : séquence whitelistée, jamais MAX()+1.
    const code = await generateTransactionalBusinessCode(client, { prefix: "PC" });
    const insert = await client.query<{ id: string; correlation_id: string }>(
      `
        INSERT INTO public.quality_control_plan (
          code, version, label, status, trigger_type,
          article_id, piece_technique_id, piece_version_id, famille_id, operation_code, fournisseur_id,
          sampling_rule, sampling_value, sampling_justification,
          owner_user_id, revision_reason, effective_from, effective_to,
          created_by, updated_by
        )
        VALUES (
          $1, 1, $2, 'DRAFT', $3,
          $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9::uuid,
          $10, $11, $12,
          $13, $14, $15::timestamptz, $16::timestamptz,
          $17, $17
        )
        RETURNING id, correlation_id
      `,
      [
        code,
        params.body.label,
        params.body.trigger_type,
        params.body.article_id ?? null,
        params.body.piece_technique_id ?? null,
        params.body.piece_version_id ?? null,
        params.body.famille_id ?? null,
        params.body.operation_code ?? null,
        params.body.fournisseur_id ?? null,
        params.body.sampling.rule,
        params.body.sampling.value,
        params.body.sampling.justification,
        params.body.owner_user_id ?? null,
        params.body.revision_reason ?? null,
        params.body.effective_from ?? null,
        params.body.effective_to ?? null,
        params.actor.user_id,
      ]
    );

    const planId = insert.rows[0]!.id;
    const correlationId = insert.rows[0]!.correlation_id;
    await replacePlanCharacteristics(client, planId, params.body.characteristics.map(toSpec));

    await insertQualityEvent(client, {
      entity_type: "PLAN",
      entity_id: planId,
      event_type: "PLAN_CREATED",
      actor: params.actor,
      old_values: null,
      new_values: { code, label: params.body.label, trigger_type: params.body.trigger_type },
      correlation_id: correlationId,
      idempotency_key: idem.idempotencyKey,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.plans.create",
      entity_type: "quality_control_plan",
      entity_id: planId,
      details: { code, characteristics: params.body.characteristics.length },
    });
    await saveReceipt({
      client,
      actor: params.actor,
      idempotencyKey: idem.idempotencyKey,
      requestHash: idem.requestHash,
      commandType: "quality.plan.create",
      aggregateType: "PLAN",
      aggregateId: planId,
      requestPayload: params.body,
      resultPayload: { plan_id: planId, code },
      correlationId,
    });

    const plan = await selectPlanRow(client, planId);
    const characteristics = await selectPlanCharacteristics(client, planId);
    return { plan: plan!, characteristics };
  });
}

export async function repoUpdatePlan(params: {
  id: string;
  body: UpdatePlanBodyDTO;
  actor: QualityActor;
}): Promise<{ plan: QualityPlanRow; characteristics: QualityCharacteristicSpec[] } | null> {
  return withTransaction(async (client) => {
    const before = await selectPlanRow(client, params.id, true);
    if (!before) return null;

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: before.updated_at,
    });
    assertPlanContentMutable(before.status);

    await client.query(
      `
        UPDATE public.quality_control_plan
        SET label = COALESCE($2, label),
            sampling_rule = COALESCE($3, sampling_rule),
            sampling_value = CASE WHEN $3 IS NULL THEN sampling_value ELSE $4 END,
            sampling_justification = CASE WHEN $3 IS NULL THEN sampling_justification ELSE $5 END,
            owner_user_id = COALESCE($6, owner_user_id),
            revision_reason = COALESCE($7, revision_reason),
            effective_from = COALESCE($8::timestamptz, effective_from),
            effective_to = COALESCE($9::timestamptz, effective_to),
            updated_by = $10
        WHERE id = $1::uuid
      `,
      [
        params.id,
        params.body.label ?? null,
        params.body.sampling?.rule ?? null,
        params.body.sampling?.value ?? null,
        params.body.sampling?.justification ?? null,
        params.body.owner_user_id ?? null,
        params.body.revision_reason ?? null,
        params.body.effective_from ?? null,
        params.body.effective_to ?? null,
        params.actor.user_id,
      ]
    );

    if (params.body.characteristics) {
      await replacePlanCharacteristics(client, params.id, params.body.characteristics.map(toSpec));
    }

    const after = await selectPlanRow(client, params.id);
    await insertQualityEvent(client, {
      entity_type: "PLAN",
      entity_id: params.id,
      event_type: "PLAN_UPDATED",
      actor: params.actor,
      old_values: before as unknown as Record<string, unknown>,
      new_values: after as unknown as Record<string, unknown>,
      correlation_id: before.id,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.plans.update",
      entity_type: "quality_control_plan",
      entity_id: params.id,
    });

    return { plan: after!, characteristics: await selectPlanCharacteristics(client, params.id) };
  });
}

async function publishedPlanCandidates(q: DbQueryer, excludePlanId: string): Promise<PlanCandidate[]> {
  const res = await q.query<QualityPlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM public.quality_control_plan p WHERE p.status = 'PUBLISHED' AND p.id <> $1::uuid`,
    [excludePlanId]
  );
  return res.rows.map(planRowToCandidate);
}

function planRowToCandidate(row: QualityPlanRow): PlanCandidate {
  return {
    id: row.id,
    code: row.code,
    version: row.version,
    status: row.status,
    scope: {
      article_id: row.article_id,
      piece_technique_id: row.piece_technique_id,
      piece_version_id: row.piece_version_id,
      famille_id: row.famille_id,
      operation_code: row.operation_code,
      fournisseur_id: row.fournisseur_id,
      trigger: row.trigger_type as PlanCandidate["scope"]["trigger"],
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    },
  };
}

export async function repoTransitionPlan(params: {
  id: string;
  body: PlanTransitionBodyDTO;
  actor: QualityActor;
}): Promise<{ plan: QualityPlanRow; characteristics: QualityCharacteristicSpec[] } | null> {
  return withTransaction(async (client) => {
    const before = await selectPlanRow(client, params.id, true);
    if (!before) return null;

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: before.updated_at,
    });
    assertPlanTransition(before.status, params.body.target_status);

    if (params.body.target_status === "PUBLISHED") {
      const characteristics = await selectPlanCharacteristics(client, params.id);
      if (characteristics.length === 0) {
        throw new HttpError(
          422,
          "QUALITY_PLAN_WITHOUT_CHARACTERISTIC",
          "Un plan sans caractéristique ne peut pas être publié."
        );
      }
      for (const spec of characteristics) assertCharacteristicSpec(spec);
      assertNoApplicabilityOverlap({
        candidate: planRowToCandidate(before),
        published: await publishedPlanCandidates(client, params.id),
      });
    }

    const timestamps =
      params.body.target_status === "PUBLISHED"
        ? `published_at = now(), published_by = $3`
        : params.body.target_status === "ARCHIVED"
          ? `archived_at = now(), archived_by = $3`
          : params.body.target_status === "IN_REVIEW"
            ? `submitted_at = now(), submitted_by = $3`
            : `submitted_at = submitted_at`;

    await client.query(
      `
        UPDATE public.quality_control_plan
        SET status = $2, ${timestamps}, updated_by = $3
        WHERE id = $1::uuid
      `,
      [params.id, params.body.target_status, params.actor.user_id]
    );

    const after = await selectPlanRow(client, params.id);
    await insertQualityEvent(client, {
      entity_type: "PLAN",
      entity_id: params.id,
      event_type: `PLAN_${params.body.target_status}`,
      actor: params.actor,
      old_values: { status: before.status },
      new_values: { status: params.body.target_status },
      correlation_id: before.id,
      rule_code: "QUALITY_PLAN_TRANSITION",
      reason: params.body.reason ?? null,
    });
    await insertAuditLog(client, params.actor, {
      action: `qualite.plans.${params.body.target_status.toLowerCase()}`,
      entity_type: "quality_control_plan",
      entity_id: params.id,
      details: { from: before.status, to: params.body.target_status, reason: params.body.reason ?? null },
    });

    return { plan: after!, characteristics: await selectPlanCharacteristics(client, params.id) };
  });
}

/** Crée la version suivante d'un plan publié : l'historique n'est jamais modifié. */
export async function repoRevisePlan(params: {
  id: string;
  revisionReason: string;
  actor: QualityActor;
}): Promise<{ plan: QualityPlanRow; characteristics: QualityCharacteristicSpec[] } | null> {
  return withTransaction(async (client) => {
    const source = await selectPlanRow(client, params.id, true);
    if (!source) return null;

    const nextVersionRes = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM public.quality_control_plan WHERE code = $1`,
      [source.code]
    );
    const nextVersion = nextVersionRes.rows[0]?.next_version ?? source.version + 1;

    const insert = await client.query<{ id: string; correlation_id: string }>(
      `
        INSERT INTO public.quality_control_plan (
          code, version, label, status, trigger_type,
          article_id, piece_technique_id, piece_version_id, famille_id, operation_code, fournisseur_id,
          sampling_rule, sampling_value, sampling_justification,
          owner_user_id, revision_reason, effective_from, effective_to, supersedes_plan_id,
          created_by, updated_by
        )
        SELECT code, $2, label, 'DRAFT', trigger_type,
               article_id, piece_technique_id, piece_version_id, famille_id, operation_code, fournisseur_id,
               sampling_rule, sampling_value, sampling_justification,
               owner_user_id, $3, effective_from, effective_to, id,
               $4, $4
        FROM public.quality_control_plan
        WHERE id = $1::uuid
        RETURNING id, correlation_id
      `,
      [params.id, nextVersion, params.revisionReason, params.actor.user_id]
    );

    const newId = insert.rows[0]!.id;
    await client.query(
      `
        INSERT INTO public.quality_control_plan_characteristic (
          plan_id, characteristic_key, position, label, characteristic_type, value_kind,
          unit, nominal, tolerance_min, tolerance_max, precision_digits, expected_boolean,
          allowed_values, criticality, mandatory, requires_instrument, instrument_category,
          method, acceptance_rule, sampling_rule, sampling_value, sampling_justification, trigger_type
        )
        SELECT $2::uuid, characteristic_key, position, label, characteristic_type, value_kind,
               unit, nominal, tolerance_min, tolerance_max, precision_digits, expected_boolean,
               allowed_values, criticality, mandatory, requires_instrument, instrument_category,
               method, acceptance_rule, sampling_rule, sampling_value, sampling_justification, trigger_type
        FROM public.quality_control_plan_characteristic
        WHERE plan_id = $1::uuid
      `,
      [params.id, newId]
    );

    await insertQualityEvent(client, {
      entity_type: "PLAN",
      entity_id: newId,
      event_type: "PLAN_REVISED",
      actor: params.actor,
      old_values: { plan_id: params.id, version: source.version },
      new_values: { plan_id: newId, version: nextVersion },
      correlation_id: insert.rows[0]!.correlation_id,
      reason: params.revisionReason,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.plans.revise",
      entity_type: "quality_control_plan",
      entity_id: newId,
      details: { source_plan_id: params.id, version: nextVersion },
    });

    return { plan: (await selectPlanRow(client, newId))!, characteristics: await selectPlanCharacteristics(client, newId) };
  });
}

export async function repoPlanApplicability(query: PlanApplicabilityQueryDTO): Promise<{
  plan: PlanCandidate;
  label: string;
  specificity: number;
  discarded: Array<{ id: string; reason: string }>;
  characteristics: Array<QualityCharacteristicSpec & { required_samples: number | null }>;
}> {
  const resolved = await resolveApplicablePlan(pool, query);
  return {
    plan: resolved.plan,
    label: resolved.label,
    specificity: resolved.specificity,
    discarded: resolved.discarded,
    characteristics: resolved.characteristics.map((spec) => ({ ...spec, required_samples: null })),
  };
}

/* ========================================================================== */
/* Exécutions de contrôle                                                     */
/* ========================================================================== */

async function buildExecutionSnapshot(
  q: DbQueryer,
  body: ExecutionPreviewBodyDTO
): Promise<{
  plan: PlanCandidate;
  characteristics: QualityCharacteristicSpec[];
  snapshot: { payload: Record<string, unknown>; sha256: string };
}> {
  const applicability = await resolveApplicablePlan(q, {
    trigger: body.trigger,
    article_id: body.article_id ?? undefined,
    piece_technique_id: body.piece_technique_id ?? undefined,
    piece_version_id: body.piece_version_id ?? undefined,
    famille_id: body.famille_id ?? undefined,
    operation_code: body.operation_code ?? undefined,
    fournisseur_id: body.fournisseur_id ?? undefined,
  });

  const snapshot = buildPlanSnapshot({
    plan: {
      id: applicability.plan.id,
      code: applicability.plan.code,
      version: applicability.plan.version,
      label: applicability.label,
      trigger: body.trigger,
      scope: applicability.plan.scope,
      published_at: applicability.published_at,
    },
    characteristics: applicability.characteristics,
    article: { id: body.article_id ?? null, code: null, designation: null },
    piece: {
      id: body.piece_technique_id ?? null,
      code: null,
      designation: null,
      version: body.piece_version_id ?? null,
    },
    population: body.population,
    sampling_algorithm: "cerp.quality.sampling.v1",
    required_documents: [],
  });

  return { plan: applicability.plan, characteristics: applicability.characteristics, snapshot };
}

/**
 * Sélection serveur du plan applicable : un seul chemin de code pour l'aperçu
 * d'applicabilité, l'aperçu d'exécution et la création réelle.
 */
async function resolveApplicablePlan(
  q: DbQueryer,
  query: PlanApplicabilityQueryDTO
): Promise<{
  plan: PlanCandidate;
  label: string;
  published_at: string | null;
  specificity: number;
  discarded: Array<{ id: string; reason: string }>;
  characteristics: QualityCharacteristicSpec[];
}> {
  const candidatesRes = await q.query<QualityPlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM public.quality_control_plan p WHERE p.trigger_type = $1`,
    [query.trigger]
  );
  const context: ApplicabilityContext = {
    article_id: query.article_id ?? null,
    piece_technique_id: query.piece_technique_id ?? null,
    piece_version_id: query.piece_version_id ?? null,
    famille_id: query.famille_id ?? null,
    operation_code: query.operation_code ?? null,
    fournisseur_id: query.fournisseur_id ?? null,
    trigger: query.trigger,
  };
  const selection = selectApplicablePlan(
    candidatesRes.rows.map(planRowToCandidate),
    context,
    query.at ? new Date(query.at) : new Date()
  );
  const row = candidatesRes.rows.find((r) => r.id === selection.plan.id)!;
  return {
    plan: selection.plan,
    label: row.label,
    published_at: row.published_at,
    specificity: selection.specificity,
    discarded: selection.discarded,
    characteristics: await selectPlanCharacteristics(q, selection.plan.id),
  };
}

export type ExecutionPreview = {
  plan: { id: string; code: string; version: number };
  snapshot_sha256: string;
  population: number;
  unite: string;
  characteristics: Array<QualityCharacteristicSpec & { required_samples: number }>;
};

async function resolveLotReleaseAllocation(
  q: DbQueryer,
  body: ExecutionPreviewBodyDTO
): Promise<ExecutionPreviewBodyDTO> {
  if (body.trigger !== "LOT_RELEASE") return body;
  if (
    body.source_type !== "LOT" ||
    !body.lot_id ||
    !body.article_id ||
    !body.bon_livraison_id ||
    !body.delivery_allocation_id ||
    body.source_id !== body.lot_id
  ) {
    throw new HttpError(
      422,
      "QUALITY_DELIVERY_RELEASE_SCOPE_REQUIRED",
      "LOT_RELEASE exige le BL, l'allocation, l'article et le lot exacts."
    );
  }
  const result = await q.query<{
    bon_livraison_id: string;
    lot_id: string | null;
    article_id: string | null;
    quantite: string;
    unite: string | null;
    piece_technique_id: string | null;
    famille_id: string | null;
  }>(
    `SELECT line.bon_livraison_id::text AS bon_livraison_id,
            allocation.lot_id::text AS lot_id,
            allocation.article_id::text AS article_id,
            allocation.quantite::text AS quantite,
            allocation.unite,
            article.piece_technique_id::text AS piece_technique_id,
            piece.famille_id::text AS famille_id
     FROM public.bon_livraison_ligne_allocations allocation
     JOIN public.bon_livraison_ligne line ON line.id = allocation.bon_livraison_ligne_id
     JOIN public.articles article ON article.id = allocation.article_id
     LEFT JOIN public.pieces_techniques piece ON piece.id = article.piece_technique_id
     WHERE allocation.id = $1::uuid`,
    [body.delivery_allocation_id]
  );
  const allocation = result.rows[0];
  if (!allocation) {
    throw new HttpError(404, "QUALITY_DELIVERY_ALLOCATION_NOT_FOUND", "Allocation de BL introuvable.");
  }
  if (
    allocation.bon_livraison_id !== body.bon_livraison_id ||
    allocation.lot_id !== body.lot_id ||
    allocation.article_id !== body.article_id
  ) {
    throw new HttpError(
      409,
      "QUALITY_DELIVERY_ALLOCATION_SCOPE_MISMATCH",
      "Le BL, l'allocation, l'article et le lot ne designent pas le meme perimetre."
    );
  }
  if (body.population > toNumber(allocation.quantite)) {
    throw new HttpError(
      422,
      "QUALITY_POPULATION_EXCEEDS_ALLOCATION",
      "La population controlee depasse la quantite de l'allocation."
    );
  }
  if (allocation.unite && allocation.unite !== body.unite) {
    throw new HttpError(
      422,
      "QUALITY_ALLOCATION_UNIT_MISMATCH",
      "L'unite du controle differe de celle de l'allocation."
    );
  }
  return {
    ...body,
    piece_technique_id: body.piece_technique_id ?? allocation.piece_technique_id,
    famille_id: body.famille_id ?? allocation.famille_id,
  };
}

export async function repoPreviewExecution(body: ExecutionPreviewBodyDTO): Promise<ExecutionPreview> {
  assertSourceRef({ source_type: body.source_type, source_id: body.source_id });
  const scopedBody = await resolveLotReleaseAllocation(pool, body);
  const built = await buildExecutionSnapshot(pool, scopedBody);
  return {
    plan: { id: built.plan.id, code: built.plan.code, version: built.plan.version },
    snapshot_sha256: built.snapshot.sha256,
    population: body.population,
    unite: body.unite,
    characteristics: built.characteristics.map((spec) => ({
      ...spec,
      required_samples: requiredSampleCount(spec, body.population),
    })),
  };
}

export type ExecutionDetail = {
  id: string;
  reference: string;
  status: string;
  verdict: QualityVerdict;
  verdict_computed: QualityVerdict | null;
  control_type: string;
  trigger_type: string | null;
  source_type: string | null;
  source_id: string | null;
  plan: { id: string; code: string; version: number } | null;
  plan_snapshot_sha256: string | null;
  snapshot_integrity: "OK" | "TAMPERED" | "ABSENT";
  unite: string | null;
  ledger: QuantityLedger;
  releasable_qty: number;
  control_date: string;
  validation_date: string | null;
  created_at: string;
  updated_at: string;
  controlled_by: number;
  bon_livraison_id: string | null;
  delivery_allocation_id: string | null;
  measurements: Array<{
    id: string;
    characteristic_key: string | null;
    sample_no: number | null;
    measured_value: number | null;
    value_boolean: boolean | null;
    value_text: string | null;
    unit: string | null;
    result: string | null;
    evaluation_code: string | null;
    instrument_id: string | null;
    revision: number;
    comment: string | null;
  }>;
};

type ExecutionRow = {
  id: string;
  reference: string;
  status: string;
  result: "OK" | "NOK" | "PARTIAL" | null;
  verdict: QualityVerdict | null;
  verdict_computed: QualityVerdict | null;
  control_type: string;
  trigger_type: string | null;
  source_type: string | null;
  source_id: string | null;
  plan_id: string | null;
  plan_version: number | null;
  plan_code: string | null;
  plan_snapshot: unknown;
  plan_snapshot_sha256: string | null;
  unite: string | null;
  qty_population: string | null;
  qty_controlled: string;
  qty_conforming: string;
  qty_released: string;
  qty_held: string;
  qty_scrapped: string;
  qty_reworked: string;
  qty_sorted: string;
  qty_returned: string;
  qty_consumed: string;
  control_date: string;
  validation_date: string | null;
  created_at: string;
  updated_at: string;
  controlled_by: number;
  lot_id: string | null;
  article_id: string | null;
  bon_livraison_id: string | null;
  delivery_allocation_id: string | null;
  correlation_id: string;
};

const EXECUTION_COLUMNS = `
  qc.id, qc.reference, qc.status::text AS status, qc.result::text AS result,
  qc.verdict, qc.verdict_computed, qc.control_type::text AS control_type, qc.trigger_type,
  qc.source_type, qc.source_id, qc.plan_id, qc.plan_version, qc.plan_snapshot, qc.plan_snapshot_sha256,
  qc.unite, qc.qty_population, qc.qty_controlled, qc.qty_conforming, qc.qty_released, qc.qty_held,
  qc.qty_scrapped, qc.qty_reworked, qc.qty_sorted, qc.qty_returned, qc.qty_consumed,
  qc.control_date, qc.validation_date, qc.created_at, qc.updated_at, qc.controlled_by,
  qc.lot_id, qc.article_id,
  qc.bon_livraison_id, qc.delivery_allocation_id, qc.correlation_id,
  p.code AS plan_code
`;

function rowToLedger(row: ExecutionRow): QuantityLedger {
  return {
    population: toNumber(row.qty_population),
    controlled: toNumber(row.qty_controlled),
    conforming: toNumber(row.qty_conforming),
    released: toNumber(row.qty_released),
    held: toNumber(row.qty_held),
    scrapped: toNumber(row.qty_scrapped),
    reworked: toNumber(row.qty_reworked),
    sorted: toNumber(row.qty_sorted),
    returned: toNumber(row.qty_returned),
    consumed: toNumber(row.qty_consumed),
  };
}

async function selectExecutionRow(q: DbQueryer, id: string, forUpdate = false): Promise<ExecutionRow | null> {
  const res = await q.query<ExecutionRow>(
    `
      SELECT ${EXECUTION_COLUMNS}
      FROM public.quality_control qc
      LEFT JOIN public.quality_control_plan p ON p.id = qc.plan_id
      WHERE qc.id = $1::uuid
      ${forUpdate ? "FOR UPDATE OF qc" : ""}
    `,
    [id]
  );
  return res.rows[0] ?? null;
}

async function selectMeasurements(q: DbQueryer, controlId: string): Promise<ExecutionDetail["measurements"]> {
  const res = await q.query<{
    id: string;
    characteristic_key: string | null;
    sample_no: number | null;
    measured_value: string | null;
    value_boolean: boolean | null;
    value_text: string | null;
    unit: string | null;
    result: string | null;
    evaluation_code: string | null;
    instrument_id: string | null;
    revision: number;
    comment: string | null;
  }>(
    `
      SELECT id, characteristic_key, sample_no, measured_value, value_boolean, value_text,
             unit, result::text AS result, evaluation_code, instrument_id, revision, comment
      FROM public.quality_control_points
      WHERE quality_control_id = $1::uuid
      ORDER BY characteristic_key NULLS LAST, sample_no NULLS LAST, created_at ASC
    `,
    [controlId]
  );
  return res.rows.map((row) => ({
    ...row,
    measured_value: row.measured_value === null ? null : Number(row.measured_value),
  }));
}

function buildExecutionDetail(row: ExecutionRow, measurements: ExecutionDetail["measurements"]): ExecutionDetail {
  const ledger = rowToLedger(row);
  let integrity: ExecutionDetail["snapshot_integrity"] = "ABSENT";
  if (row.plan_snapshot_sha256) {
    try {
      assertSnapshotIntegrity(row.plan_snapshot, row.plan_snapshot_sha256);
      integrity = "OK";
    } catch {
      integrity = "TAMPERED";
    }
  }
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    verdict: row.verdict ?? legacyResultToVerdict(row.result),
    verdict_computed: row.verdict_computed,
    control_type: row.control_type,
    trigger_type: row.trigger_type,
    source_type: row.source_type,
    source_id: row.source_id,
    plan: row.plan_id ? { id: row.plan_id, code: row.plan_code ?? "", version: row.plan_version ?? 1 } : null,
    plan_snapshot_sha256: row.plan_snapshot_sha256,
    snapshot_integrity: integrity,
    unite: row.unite,
    ledger,
    releasable_qty: ledger.population > 0 ? releasableQty(ledger) : 0,
    control_date: row.control_date,
    validation_date: row.validation_date,
    created_at: row.created_at,
    updated_at: row.updated_at,
    controlled_by: row.controlled_by,
    bon_livraison_id: row.bon_livraison_id,
    delivery_allocation_id: row.delivery_allocation_id,
    measurements,
  };
}

export async function repoGetExecution(id: string): Promise<ExecutionDetail | null> {
  const row = await selectExecutionRow(pool, id);
  if (!row) return null;
  return buildExecutionDetail(row, await selectMeasurements(pool, id));
}

const EXECUTION_SORT_COLUMNS: Record<ListExecutionsQueryDTO["sortBy"], string> = {
  control_date: "qc.control_date",
  updated_at: "qc.updated_at",
  verdict: "qc.verdict",
  reference: "qc.reference",
};

export async function repoListExecutions(
  filters: ListExecutionsQueryDTO
): Promise<{ items: ExecutionDetail[]; total: number }> {
  const clauses: string[] = ["TRUE"];
  const values: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(sql.replace("$?", `$${values.length}`));
  };

  if (filters.q) push("qc.reference ILIKE $?", `%${filters.q}%`);
  if (filters.status) push("qc.status = $?::public.quality_control_status", filters.status);
  if (filters.verdict) push("qc.verdict = $?", filters.verdict);
  if (filters.trigger) push("qc.trigger_type = $?", filters.trigger);
  if (filters.source_type) push("qc.source_type = $?", filters.source_type);
  if (filters.source_id) push("qc.source_id = $?", filters.source_id);
  if (filters.plan_id) push("qc.plan_id = $?::uuid", filters.plan_id);
  if (filters.lot_id) push("qc.lot_id = $?::uuid", filters.lot_id);

  const whereSql = clauses.join(" AND ");
  const totalRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.quality_control qc WHERE ${whereSql}`,
    values
  );
  const itemsRes = await pool.query<ExecutionRow>(
    `
      SELECT ${EXECUTION_COLUMNS}
      FROM public.quality_control qc
      LEFT JOIN public.quality_control_plan p ON p.id = qc.plan_id
      WHERE ${whereSql}
      ORDER BY ${EXECUTION_SORT_COLUMNS[filters.sortBy]} ${sortDirection(filters.sortDir)} NULLS LAST, qc.id ASC
      LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}
    `,
    values
  );

  return {
    items: itemsRes.rows.map((row) => buildExecutionDetail(row, [])),
    total: totalRes.rows[0]?.total ?? 0,
  };
}

export async function repoCreateExecution(params: {
  body: CreateExecutionBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<ExecutionDetail> {
  const source = assertSourceRef({
    source_type: params.body.source_type,
    source_id: params.body.source_id,
  });

  return withTransaction(async (client) => {
    const idem = await acquireIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "quality.execution.create",
      requestPayload: params.body,
    });
    if (idem.replay) {
      const replayed = await selectExecutionRow(client, String(idem.replay.control_id));
      if (replayed) return buildExecutionDetail(replayed, await selectMeasurements(client, replayed.id));
    }

    const scopedBody = await resolveLotReleaseAllocation(client, params.body);
    const built = await buildExecutionSnapshot(client, scopedBody);
    // L'aperçu doit encore correspondre au plan applicable : sinon le référentiel
    // a bougé entre l'aperçu et la confirmation.
    assertPreviewFresh({
      expectedHash: params.body.preview_sha256,
      currentHash: built.snapshot.sha256,
    });

    const reference = await generateTransactionalBusinessCode(client, { prefix: "CQ" });
    const controlType = legacyControlType(params.body.trigger);

    const insert = await client.query<{ id: string; correlation_id: string }>(
      `
        INSERT INTO public.quality_control (
          reference, control_type, status, control_date, controlled_by,
          affaire_id, of_id, piece_technique_id, operation_id,
          plan_id, plan_version, plan_snapshot, plan_snapshot_sha256,
          source_type, source_id, trigger_type,
          lot_id, article_id, fournisseur_id, reception_ligne_id,
          bon_livraison_id, delivery_allocation_id,
          unite, qty_population, verdict, verdict_computed, comments,
          created_by, updated_by
        )
        VALUES (
          $1, $2::public.quality_control_type, 'IN_PROGRESS', now(), $3,
          NULL, $4, $5::uuid, NULL,
          $6::uuid, $7, $8::jsonb, $9,
          $10, $11, $12,
          $13::uuid, $14::uuid, $15::uuid, $16::uuid,
          $17::uuid, $18::uuid,
          $19, $20, 'EN_ATTENTE', 'EN_ATTENTE', $21,
          $22, $22
        )
        RETURNING id, correlation_id
      `,
      [
        reference,
        controlType,
        params.body.controlled_by ?? params.actor.user_id,
        params.body.of_id ?? null,
        params.body.piece_technique_id ?? null,
        built.plan.id,
        built.plan.version,
        JSON.stringify(built.snapshot.payload),
        built.snapshot.sha256,
        source.source_type,
        source.source_id,
        params.body.trigger,
        params.body.lot_id ?? null,
        params.body.article_id ?? null,
        params.body.fournisseur_id ?? null,
        params.body.reception_ligne_id ?? null,
        params.body.bon_livraison_id ?? null,
        params.body.delivery_allocation_id ?? null,
        params.body.unite,
        params.body.population,
        params.body.comments ?? null,
        params.actor.user_id,
      ]
    );

    const controlId = insert.rows[0]!.id;
    const correlationId = insert.rows[0]!.correlation_id;

    await insertQualityEvent(client, {
      entity_type: "CONTROL",
      entity_id: controlId,
      event_type: "EXECUTION_CREATED",
      actor: params.actor,
      old_values: null,
      new_values: {
        reference,
        plan_id: built.plan.id,
        plan_version: built.plan.version,
        plan_snapshot_sha256: built.snapshot.sha256,
        source: source,
        population: params.body.population,
      },
      correlation_id: correlationId,
      idempotency_key: idem.idempotencyKey,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.executions.create",
      entity_type: "quality_control",
      entity_id: controlId,
      details: { reference, plan_code: built.plan.code, sha256: built.snapshot.sha256 },
    });
    await saveReceipt({
      client,
      actor: params.actor,
      idempotencyKey: idem.idempotencyKey,
      requestHash: idem.requestHash,
      commandType: "quality.execution.create",
      aggregateType: "CONTROL",
      aggregateId: controlId,
      requestPayload: params.body,
      resultPayload: { control_id: controlId, reference },
      correlationId,
    });

    const row = await selectExecutionRow(client, controlId);
    return buildExecutionDetail(row!, []);
  });
}

// Le type historique `quality_control_type` reste la colonne de compatibilité.
function legacyControlType(trigger: string): "IN_PROCESS" | "FINAL" | "RECEPTION" | "PERIODIC" {
  switch (trigger) {
    case "RECEPTION":
      return "RECEPTION";
    case "PERIODIC":
      return "PERIODIC";
    case "IN_PROCESS":
    case "FIRST_ARTICLE":
      return "IN_PROCESS";
    default:
      return "FINAL";
  }
}

/**
 * #229 — L'éligibilité d'un instrument est décidée par le MOTEUR DE MÉTROLOGIE,
 * pas ici. La règle vivait à deux endroits (une lecture SQL locale + une
 * évaluation partielle) ; elle vit désormais dans
 * `module/metrologie/domain/metrology-eligibility.ts` et le module Qualité s'y
 * adresse. Cela apporte, sans changer un seul contrat consommateur :
 *   - la quarantaine et le hors tolérance (états #229) ;
 *   - la compatibilité méthode / unité / plage / résolution ;
 *   - l'exigence de certificat valide ;
 *   - la stratégie de blocage portée par la version de plan applicable.
 */
async function evaluateInstrumentForCharacteristic(
  q: DbQueryer,
  params: {
    spec: QualityCharacteristicSpec;
    instrumentId: string | null;
    at: Date;
  }
): Promise<{
  allowed: boolean;
  severity: "OK" | "WARNING" | "BLOCKING";
  code: string;
  message: string;
  snapshot: MetrologyInstrumentSnapshot | null;
}> {
  const { spec } = params;
  const bounds = resolveCharacteristicBounds(spec);
  const requirement: MetrologyUsageRequirement = {
    characteristic_key: spec.key,
    requires_instrument: spec.requires_instrument,
    instrument_category: spec.instrument_category,
    method: spec.method,
    unit: spec.unit,
    nominal: spec.nominal,
    tolerance_min: bounds.min,
    tolerance_max: bounds.max,
    // Une caractéristique critique exige une preuve documentaire opposable.
    requires_certificate: spec.criticality === "CRITICAL",
  };

  if (!spec.requires_instrument && !params.instrumentId) {
    return {
      allowed: true,
      severity: "OK",
      code: "OK",
      message: "Aucun moyen de contrôle requis.",
      snapshot: null,
    };
  }

  if (!params.instrumentId) {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_REQUIRED",
      message: `La caractéristique ${spec.key} exige l'instrument réellement utilisé.`,
      snapshot: null,
    };
  }

  const evaluation = await repoBuildInstrumentSnapshot({
    q,
    instrumentId: params.instrumentId,
    requirement,
    at: params.at,
  });
  if (!evaluation) {
    return {
      allowed: false,
      severity: "BLOCKING",
      code: "INSTRUMENT_UNKNOWN",
      message: "Instrument de métrologie inconnu.",
      snapshot: null,
    };
  }

  return {
    allowed: evaluation.eligibility.eligible,
    severity: evaluation.eligibility.severity,
    code: evaluation.eligibility.code,
    message: evaluation.eligibility.message,
    snapshot: evaluation.snapshot,
  };
}

export async function repoRecordMeasurements(params: {
  id: string;
  body: RecordMeasurementsBodyDTO;
  actor: QualityActor;
}): Promise<ExecutionDetail | null> {
  return withTransaction(async (client) => {
    const before = await selectExecutionRow(client, params.id, true);
    if (!before) return null;

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: before.updated_at,
    });
    if (before.validation_date) {
      throw new HttpError(
        409,
        "QUALITY_EXECUTION_CLOSED",
        "Ce contrôle est validé : une correction passe par une révision auditée."
      );
    }
    if (!before.plan_snapshot_sha256) {
      throw new HttpError(
        409,
        "QUALITY_SNAPSHOT_MISSING",
        "Cette exécution n'a pas de plan figé : elle ne peut pas recevoir de mesure."
      );
    }
    assertSnapshotIntegrity(before.plan_snapshot, before.plan_snapshot_sha256);

    const specs = characteristicsFromSnapshot(before.plan_snapshot);
    const specByKey = new Map(specs.map((spec) => [spec.key, spec]));
    const now = new Date();
    const warnings: Array<{ characteristic_key: string; code: string; message: string }> = [];

    for (const measurement of params.body.measurements) {
      const spec = specByKey.get(measurement.characteristic_key);
      if (!spec) {
        throw new HttpError(
          422,
          "QUALITY_CHARACTERISTIC_UNKNOWN",
          `La caractéristique ${measurement.characteristic_key} n'appartient pas au plan figé.`
        );
      }
      const expected = requiredSampleCount(spec, toNumber(before.qty_population));
      if (measurement.sample_no > Math.max(expected, 1)) {
        throw new HttpError(
          422,
          "QUALITY_SAMPLE_OUT_OF_RANGE",
          `Échantillon ${measurement.sample_no} hors du plan d'échantillonnage (${expected} attendu(s)).`,
          { characteristic: spec.key, expected_samples: expected }
        );
      }

      // #229 — Le serveur arbitre l'emploi de l'instrument et fige un snapshot
      // immuable : une modification future du registre, du plan ou du
      // certificat ne réécrira pas ce contrôle déjà exécuté.
      const instrumentCheck = await evaluateInstrumentForCharacteristic(client, {
        spec,
        instrumentId: measurement.instrument_id ?? null,
        at: now,
      });
      const instrumentSnapshot = instrumentCheck.snapshot;
      if (instrumentCheck.code === "INSTRUMENT_UNKNOWN") {
        throw new HttpError(422, "INSTRUMENT_UNKNOWN", "Instrument de métrologie inconnu.");
      }
      if (!instrumentCheck.allowed) {
        throw new HttpError(409, instrumentCheck.code, instrumentCheck.message, {
          characteristic: spec.key,
          instrument_id: measurement.instrument_id ?? null,
        });
      }
      if (instrumentCheck.severity === "WARNING") {
        warnings.push({
          characteristic_key: spec.key,
          code: instrumentCheck.code,
          message: instrumentCheck.message,
        });
      }

      const evaluation = evaluateSampleForSpec(spec, measurement);

      const existing = await client.query<{ id: string; revision: number; snapshot: Record<string, unknown> }>(
        `
          SELECT id, revision,
                 jsonb_build_object(
                   'measured_value', measured_value, 'value_boolean', value_boolean,
                   'value_text', value_text, 'unit', unit, 'result', result::text,
                   'instrument_id', instrument_id, 'evaluation_code', evaluation_code
                 ) AS snapshot
          FROM public.quality_control_points
          WHERE quality_control_id = $1::uuid AND characteristic_key = $2 AND sample_no = $3
          FOR UPDATE
        `,
        [params.id, spec.key, measurement.sample_no]
      );

      const previous = existing.rows[0] ?? null;
      if (previous) {
        const reason = (params.body.correction_reason ?? "").trim();
        if (reason.length < 5) {
          throw new HttpError(
            422,
            "QUALITY_MEASUREMENT_CORRECTION_REASON_REQUIRED",
            "Corriger une mesure existante exige un motif d'au moins 5 caractères."
          );
        }
        const nextRevision = previous.revision + 1;
        await client.query(
          `
            UPDATE public.quality_control_points
            SET measured_value = $2, value_boolean = $3, value_text = $4, unit = $5,
                result = $6::public.quality_point_result, evaluation_code = $7,
                instrument_id = $8::uuid, instrument_snapshot = $9::jsonb, criticality = $10,
                comment = $11, measured_at = now(), recorded_by = $12, revision = $13
            WHERE id = $1::uuid
          `,
          [
            previous.id,
            measurement.value_numeric,
            measurement.value_boolean,
            measurement.value_text,
            measurement.unit ?? spec.unit,
            evaluation.result === "PENDING" ? null : evaluation.result,
            evaluation.code,
            measurement.instrument_id ?? null,
            instrumentSnapshot ? JSON.stringify(instrumentSnapshot) : null,
            spec.criticality,
            measurement.comment,
            params.actor.user_id,
            nextRevision,
          ]
        );
        // Historique avant/après : jamais d'écrasement silencieux.
        await client.query(
          `
            INSERT INTO public.quality_measurement_revisions (
              point_id, quality_control_id, revision, old_values, new_values, reason, actor_user_id
            )
            VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7)
          `,
          [
            previous.id,
            params.id,
            nextRevision,
            JSON.stringify(previous.snapshot),
            JSON.stringify({
              measured_value: measurement.value_numeric,
              value_boolean: measurement.value_boolean,
              value_text: measurement.value_text,
              unit: measurement.unit ?? spec.unit,
              result: evaluation.result,
              evaluation_code: evaluation.code,
              instrument_id: measurement.instrument_id ?? null,
            }),
            reason,
            params.actor.user_id,
          ]
        );
      } else {
        await client.query(
          `
            INSERT INTO public.quality_control_points (
              quality_control_id, characteristic, characteristic_key, sample_no,
              nominal_value, tolerance_min, tolerance_max, measured_value,
              value_boolean, value_text, unit, result, evaluation_code,
              instrument_id, instrument_snapshot, criticality, comment, measured_at, recorded_by
            )
            VALUES (
              $1::uuid, $2, $3, $4,
              $5, $6, $7, $8,
              $9, $10, $11, $12::public.quality_point_result, $13,
              $14::uuid, $15::jsonb, $16, $17, now(), $18
            )
          `,
          [
            params.id,
            spec.label,
            spec.key,
            measurement.sample_no,
            spec.nominal,
            spec.tolerance_min,
            spec.tolerance_max,
            measurement.value_numeric,
            measurement.value_boolean,
            measurement.value_text,
            measurement.unit ?? spec.unit,
            evaluation.result === "PENDING" ? null : evaluation.result,
            evaluation.code,
            measurement.instrument_id ?? null,
            instrumentSnapshot ? JSON.stringify(instrumentSnapshot) : null,
            spec.criticality,
            measurement.comment,
            params.actor.user_id,
          ]
        );
      }
    }

    const computed = await recomputeExecutionLedger(client, params.id, specs);

    await client.query(
      `UPDATE public.quality_control SET updated_by = $2 WHERE id = $1::uuid`,
      [params.id, params.actor.user_id]
    );

    await insertQualityEvent(client, {
      entity_type: "CONTROL",
      entity_id: params.id,
      event_type: "MEASUREMENTS_RECORDED",
      actor: params.actor,
      old_values: { verdict_computed: before.verdict_computed },
      new_values: {
        verdict_computed: computed.verdict,
        recorded: params.body.measurements.length,
        warnings,
      },
      correlation_id: before.correlation_id,
      reason: params.body.correction_reason ?? null,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.executions.measurements",
      entity_type: "quality_control",
      entity_id: params.id,
      details: { recorded: params.body.measurements.length, verdict_computed: computed.verdict },
    });

    const after = await selectExecutionRow(client, params.id);
    return buildExecutionDetail(after!, await selectMeasurements(client, params.id));
  });
}

function evaluateSampleForSpec(
  spec: QualityCharacteristicSpec,
  measurement: {
    characteristic_key: string;
    sample_no: number;
    value_numeric: number | null;
    value_boolean: boolean | null;
    value_text: string | null;
    unit: string | null;
  }
) {
  const sample: QualitySampleValue = {
    characteristic_key: measurement.characteristic_key,
    sample_no: measurement.sample_no,
    value_numeric: measurement.value_numeric,
    value_boolean: measurement.value_boolean,
    value_text: measurement.value_text,
    unit: measurement.unit,
    evidence_count: 0,
  };
  return evaluateSample(spec, sample);
}

async function loadSamples(q: DbQueryer, controlId: string): Promise<QualitySampleValue[]> {
  const res = await q.query<{
    characteristic_key: string | null;
    sample_no: number | null;
    measured_value: string | null;
    value_boolean: boolean | null;
    value_text: string | null;
    unit: string | null;
    evidence_count: number;
  }>(
    `
      SELECT p.characteristic_key, p.sample_no, p.measured_value, p.value_boolean, p.value_text, p.unit,
             (SELECT COUNT(*)::int FROM public.quality_documents d
               WHERE d.entity_type = 'CONTROL' AND d.entity_id = p.quality_control_id AND d.removed_at IS NULL
             ) AS evidence_count
      FROM public.quality_control_points p
      WHERE p.quality_control_id = $1::uuid AND p.characteristic_key IS NOT NULL AND p.sample_no IS NOT NULL
    `,
    [controlId]
  );
  return res.rows.map((row) => ({
    characteristic_key: row.characteristic_key!,
    sample_no: row.sample_no!,
    value_numeric: row.measured_value === null ? null : Number(row.measured_value),
    value_boolean: row.value_boolean,
    value_text: row.value_text,
    unit: row.unit,
    evidence_count: row.evidence_count,
  }));
}

async function recomputeExecutionLedger(
  tx: DbQueryer,
  controlId: string,
  specs: readonly QualityCharacteristicSpec[]
): Promise<{ verdict: QualityVerdict; controlled: number; conforming: number }> {
  const row = await selectExecutionRow(tx, controlId);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Contrôle introuvable.");

  const population = toNumber(row.qty_population);
  const samples = await loadSamples(tx, controlId);
  const computation = computeExecutionVerdict({ characteristics: specs, samples, population });

  // Quantité contrôlée = nombre d'unités distinctes réellement évaluées,
  // plafonné par la population. Quantité conforme = unités sans aucun NOK.
  const unitsEvaluated = new Set<number>();
  const unitsWithNok = new Set<number>();
  for (const evaluation of computation.evaluations) {
    if (evaluation.result === "PENDING") continue;
    unitsEvaluated.add(evaluation.sample_no);
    if (evaluation.result === "NOK") unitsWithNok.add(evaluation.sample_no);
  }
  const sampled = Math.min(unitsEvaluated.size, population > 0 ? population : unitsEvaluated.size);
  const conformingSamples = Math.max(0, sampled - unitsWithNok.size);

  // L'extrapolation à la population n'est jamais implicite : quand le plan est
  // en échantillonnage, la quantité conforme reste la quantité réellement
  // contrôlée, sauf verdict CONFORME sur la totalité de la population.
  const controlled =
    computation.verdict === "CONFORME" && sampled > 0 && population > 0 ? population : sampled;
  const conforming =
    computation.verdict === "CONFORME"
      ? controlled
      : computation.verdict === "NON_CONFORME"
        ? 0
        : conformingSamples;

  const ledger: QuantityLedger = { ...rowToLedger(row), controlled, conforming };
  if (population > 0) assertQuantityLedger(ledger);

  await tx.query(
    `
      UPDATE public.quality_control
      SET qty_controlled = $2, qty_conforming = $3, verdict_computed = $4,
          verdict = CASE WHEN validation_date IS NULL THEN $4 ELSE verdict END,
          status = CASE
            WHEN validation_date IS NULL THEN 'IN_PROGRESS'::public.quality_control_status
            ELSE status
          END
      WHERE id = $1::uuid
    `,
    [controlId, controlled, conforming, computation.verdict]
  );

  return { verdict: computation.verdict, controlled, conforming };
}

export type VerdictPreview = {
  control_id: string;
  verdict: QualityVerdict;
  missing: Array<{ characteristic_key: string; expected_samples: number; recorded_samples: number }>;
  blocking: Array<{ characteristic_key: string; criticality: string; code: string }>;
  ledger: QuantityLedger;
  releasable_qty: number;
  preview_sha256: string;
};

export async function repoPreviewVerdict(id: string): Promise<VerdictPreview | null> {
  const row = await selectExecutionRow(pool, id);
  if (!row) return null;
  if (!row.plan_snapshot_sha256) {
    throw new HttpError(409, "QUALITY_SNAPSHOT_MISSING", "Cette exécution n'a pas de plan figé.");
  }
  assertSnapshotIntegrity(row.plan_snapshot, row.plan_snapshot_sha256);

  const specs = characteristicsFromSnapshot(row.plan_snapshot);
  const samples = await loadSamples(pool, id);
  const population = toNumber(row.qty_population);
  const computation = computeExecutionVerdict({ characteristics: specs, samples, population });
  const ledger = rowToLedger(row);

  const payload = {
    control_id: id,
    verdict: computation.verdict,
    ledger,
    snapshot_sha256: row.plan_snapshot_sha256,
  };

  return {
    control_id: id,
    verdict: computation.verdict,
    missing: computation.missing,
    blocking: computation.blocking,
    ledger,
    releasable_qty: population > 0 ? releasableQty(ledger) : 0,
    preview_sha256: qualitySha256(payload),
  };
}

async function releaseQuarantinedLotForFullDeliveryDecision(params: {
  client: DbQueryer;
  execution: ExecutionRow;
  decision: DecideExecutionBodyDTO;
  releasedQty: number;
  actor: QualityActor;
  releaseDecisionId: string;
}): Promise<boolean> {
  const { execution, decision } = params;
  const population = toNumber(execution.qty_population);
  if (
    execution.trigger_type !== "LOT_RELEASE" ||
    execution.source_type !== "LOT" ||
    !execution.lot_id ||
    !execution.bon_livraison_id ||
    !execution.delivery_allocation_id ||
    decision.decision !== "FULL" ||
    decision.object_type !== "LOT" ||
    decision.object_id !== execution.source_id ||
    decision.object_id !== execution.lot_id ||
    params.releasedQty + 1e-9 < population
  ) return false;

  // Match the delivery quality gate's lock order so an NC/derogation created
  // for an already selected lot cannot race this authoritative release.
  await params.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `quality-delivery:${execution.bon_livraison_id}`,
  ]);
  await params.client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `quality-lot:${execution.lot_id}`,
  ]);

  const locked = await params.client.query<{ lot_status: string | null }>(
    `
      SELECT lot.lot_status::text AS lot_status
      FROM public.lots lot
      JOIN public.bon_livraison_ligne_allocations allocation
        ON allocation.lot_id = lot.id
      WHERE lot.id = $1::uuid
        AND allocation.id = $2::uuid
        AND ($3::uuid IS NULL OR allocation.article_id = $3::uuid)
      FOR UPDATE OF lot
    `,
    [execution.lot_id, execution.delivery_allocation_id, execution.article_id]
  );
  const row = locked.rows[0] ?? null;
  if (!row) {
    throw new HttpError(409, "QUALITY_DELIVERY_ALLOCATION_SCOPE_MISMATCH", "Le lot contrôlé n'est plus lié à l'allocation de livraison figée.");
  }
  if (row.lot_status === "LIBERE") return false;
  if (row.lot_status !== "QUARANTAINE") {
    throw new HttpError(
      409,
      "QUALITY_LOT_RELEASE_STATE_INVALID",
      "La libération de livraison ne peut faire sortir que le lot exact de quarantaine."
    );
  }

  await params.client.query(
    `
      UPDATE public.lots
      SET lot_status = 'LIBERE',
          lot_status_note = $2,
          updated_at = now(),
          updated_by = $3
      WHERE id = $1::uuid
    `,
    [execution.lot_id, `Libération Qualité BL: décision ${params.releaseDecisionId}`, params.actor.user_id]
  );
  await params.client.query(
    `
      INSERT INTO public.stock_lot_event_log (
        lot_id, event_type, old_values, new_values, actor_user_id, correlation_id
      ) VALUES ($1::uuid, 'QUALITY_DELIVERY_RELEASED', $2::jsonb, $3::jsonb, $4, $5::uuid)
    `,
    [
      execution.lot_id,
      JSON.stringify({ lot_status: row.lot_status }),
      JSON.stringify({
        lot_status: "LIBERE",
        quality_control_id: execution.id,
        release_decision_id: params.releaseDecisionId,
        delivery_allocation_id: execution.delivery_allocation_id,
      }),
      params.actor.user_id,
      execution.correlation_id,
    ]
  );
  await insertQualityEvent(params.client, {
    entity_type: "CONTROL",
    entity_id: execution.id,
    event_type: "DELIVERY_LOT_RELEASED",
    actor: params.actor,
    old_values: { lot_status: row.lot_status },
    new_values: { lot_status: "LIBERE", delivery_allocation_id: execution.delivery_allocation_id },
    correlation_id: execution.correlation_id,
    rule_code: "QUALITY_DELIVERY_FULL_RELEASE",
  });
  await insertAuditLog(params.client, params.actor, {
    action: "qualite.executions.delivery_lot.release",
    entity_type: "lots",
    entity_id: execution.lot_id,
    details: {
      quality_control_id: execution.id,
      release_decision_id: params.releaseDecisionId,
      delivery_allocation_id: execution.delivery_allocation_id,
      before: "QUARANTAINE",
      after: "LIBERE",
    },
  });
  return true;
}

export async function repoDecideExecution(params: {
  id: string;
  body: DecideExecutionBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<ExecutionDetail | null> {
  return withTransaction(async (client) => {
    const before = await selectExecutionRow(client, params.id, true);
    if (!before) return null;

    const idem = await acquireIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "quality.execution.decide",
      requestPayload: { id: params.id, ...params.body },
    });
    if (idem.replay) {
      const replayed = await selectExecutionRow(client, params.id);
      return buildExecutionDetail(replayed!, await selectMeasurements(client, params.id));
    }

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: before.updated_at,
    });
    if (before.validation_date) {
      throw new HttpError(409, "ALREADY_VALIDATED", "Ce contrôle est déjà décidé.");
    }
    if (!before.plan_snapshot_sha256) {
      throw new HttpError(409, "QUALITY_SNAPSHOT_MISSING", "Cette exécution n'a pas de plan figé.");
    }
    assertSnapshotIntegrity(before.plan_snapshot, before.plan_snapshot_sha256);

    // L'auteur de l'exécution ne prononce pas lui-même la libération.
    assertReleaseSeparation({
      executorUserId: before.controlled_by,
      deciderUserId: params.actor.user_id,
    });
    if (params.body.object_type !== before.source_type || params.body.object_id !== before.source_id) {
      throw new HttpError(
        409,
        "QUALITY_RELEASE_SCOPE_MISMATCH",
        "La decision doit porter sur la source exacte figee dans l'execution."
      );
    }

    const specs = characteristicsFromSnapshot(before.plan_snapshot);
    const samples = await loadSamples(client, params.id);
    const population = toNumber(before.qty_population);
    const computation = computeExecutionVerdict({ characteristics: specs, samples, population });

    const evidenceRes = await client.query<{ total: number }>(
      `
        SELECT COUNT(*)::int AS total FROM public.quality_documents
        WHERE entity_type = 'CONTROL' AND entity_id = $1::uuid AND removed_at IS NULL
      `,
      [params.id]
    );
    const evidenceCount = evidenceRes.rows[0]?.total ?? 0;

    const requestedVerdict = params.body.verdict_override ?? computation.verdict;
    assertManualVerdictOverride({
      computed: computation.verdict,
      requested: requestedVerdict,
      justification: params.body.justification ?? null,
      evidenceCount,
      requireEvidence: true,
    });

    // L'aperçu doit être frais : il porte le verdict calculé et le registre.
    assertPreviewFresh({
      expectedHash: params.body.preview_sha256,
      currentHash: qualitySha256({
        control_id: params.id,
        verdict: computation.verdict,
        ledger: rowToLedger(before),
        snapshot_sha256: before.plan_snapshot_sha256,
      }),
    });

    let derogation: DerogationState | null = null;
    if (params.body.derogation_id) {
      derogation = await loadDerogation(client, params.body.derogation_id, true);
      if (!derogation) throw new HttpError(404, "NOT_FOUND", "Dérogation introuvable.");
      const usage = evaluateDerogationUsage({
        derogation,
        context: {
          article_id: null,
          piece_technique_id: null,
          piece_version_id: null,
          lot_id: params.body.object_type === "LOT" ? params.body.object_id : null,
          of_id: null,
          commande_id: null,
          bon_livraison_id: null,
          unit: params.body.unite,
        },
        qty: params.body.qty,
        at: new Date(),
      });
      if (!usage.allowed) {
        throw new HttpError(409, usage.code, usage.message, { derogation_id: derogation.id });
      }
    }

    const outcome = evaluateReleaseRequest({
      decision: params.body.decision,
      qty: params.body.qty,
      unit: params.body.unite,
      ledger: rowToLedger(before),
      verdict: requestedVerdict,
      hasDerogation: derogation !== null,
      evidenceCount,
    });

    await client.query(
      `
        UPDATE public.quality_control
        SET verdict = $2, verdict_computed = $3,
            verdict_override_reason = $4, verdict_overridden_by = $5,
            result = $6::public.quality_control_result,
            status = $7::public.quality_control_status,
            validated_by = $8, validation_date = now(),
            qty_released = $9, qty_held = $10, updated_by = $8
        WHERE id = $1::uuid
      `,
      [
        params.id,
        requestedVerdict,
        computation.verdict,
        requestedVerdict === computation.verdict ? null : params.body.justification ?? null,
        requestedVerdict === computation.verdict ? null : params.actor.user_id,
        verdictToLegacyResult(requestedVerdict),
        executionStatusForVerdict(requestedVerdict),
        params.actor.user_id,
        outcome.ledger.released,
        outcome.ledger.held,
      ]
    );

    const decisionRes = await client.query<{ id: string }>(
      `
        INSERT INTO public.quality_release_decision (
          quality_control_id, decision, object_type, object_id, qty, unite,
          verdict, derogation_id, justification, decided_by, executed_by,
          preview_sha256, idempotency_key, correlation_id
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10, $11, $12, $13, $14::uuid)
        RETURNING id
      `,
      [
        params.id,
        params.body.decision,
        params.body.object_type,
        params.body.object_id,
        params.body.decision === "HOLD" ? outcome.qty_held : outcome.qty_released,
        params.body.unite,
        requestedVerdict,
        derogation?.id ?? null,
        params.body.justification ?? null,
        params.actor.user_id,
        before.controlled_by,
        params.body.preview_sha256,
        idem.idempotencyKey,
        before.correlation_id,
      ]
    );
    const decisionId = decisionRes.rows[0]!.id;

    const deliveryLotReleased = await releaseQuarantinedLotForFullDeliveryDecision({
      client,
      execution: before,
      decision: params.body,
      releasedQty: outcome.qty_released,
      actor: params.actor,
      releaseDecisionId: decisionId,
    });

    if (derogation) {
      await consumeDerogationInternal(client, {
        derogationId: derogation.id,
        qty: params.body.qty,
        unite: params.body.unite,
        actor: params.actor,
        releaseDecisionId: decisionId,
        qualityControlId: params.id,
        idempotencyKey: idem.idempotencyKey,
        context: { source: "release_decision" },
      });
    }

    await insertQualityEvent(client, {
      entity_type: "RELEASE",
      entity_id: decisionId,
      event_type: `RELEASE_${params.body.decision}`,
      actor: params.actor,
      old_values: { verdict: before.verdict, ledger: rowToLedger(before) },
      new_values: {
        verdict: requestedVerdict,
        verdict_computed: computation.verdict,
        ledger: outcome.ledger,
        qty_released: outcome.qty_released,
        qty_held: outcome.qty_held,
        derogation_id: derogation?.id ?? null,
        delivery_lot_released: deliveryLotReleased,
      },
      correlation_id: before.correlation_id,
      idempotency_key: idem.idempotencyKey,
      rule_code: "QUALITY_RELEASE_DECISION",
      reason: params.body.justification ?? null,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.executions.decide",
      entity_type: "quality_control",
      entity_id: params.id,
      details: {
        decision: params.body.decision,
        qty: params.body.qty,
        verdict: requestedVerdict,
        derogation_id: derogation?.id ?? null,
      },
    });
    await saveReceipt({
      client,
      actor: params.actor,
      idempotencyKey: idem.idempotencyKey,
      requestHash: idem.requestHash,
      commandType: "quality.execution.decide",
      aggregateType: "RELEASE",
      aggregateId: decisionId,
      requestPayload: { id: params.id, ...params.body },
      resultPayload: { control_id: params.id, decision_id: decisionId },
      correlationId: before.correlation_id,
    });

    const after = await selectExecutionRow(client, params.id);
    return buildExecutionDetail(after!, await selectMeasurements(client, params.id));
  });
}

/* ========================================================================== */
/* Dérogations                                                                */
/* ========================================================================== */

type DerogationRow = DerogationState & {
  derogation_type: string;
  non_conformity_id: string | null;
  requirement: string;
  deviation: string;
  risk_analysis: string | null;
  conditions: string | null;
  requested_by: number;
  approved_by: number | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
};

async function loadDerogation(
  q: DbQueryer,
  id: string,
  forUpdate = false
): Promise<DerogationRow | null> {
  const res = await q.query<{
    id: string;
    code: string;
    status: string;
    derogation_type: string;
    non_conformity_id: string | null;
    article_id: string | null;
    piece_technique_id: string | null;
    piece_version_id: string | null;
    lot_id: string | null;
    of_id: string | null;
    commande_id: string | null;
    bon_livraison_id: string | null;
    requirement: string;
    deviation: string;
    risk_analysis: string | null;
    conditions: string | null;
    max_qty: string | null;
    unite: string | null;
    consumed_qty: string;
    valid_from: string | null;
    valid_to: string | null;
    requested_by: number;
    approved_by: number | null;
    approved_at: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, code, status, derogation_type, non_conformity_id,
             article_id, piece_technique_id, piece_version_id, lot_id,
             of_id::text AS of_id, commande_id, bon_livraison_id,
             requirement, deviation, risk_analysis, conditions,
             max_qty, unite, consumed_qty, valid_from, valid_to,
             requested_by, approved_by, approved_at, created_at, updated_at
      FROM public.quality_derogation
      WHERE id = $1::uuid
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    max_qty: row.max_qty === null ? null : Number(row.max_qty),
    consumed_qty: Number(row.consumed_qty),
    unit: row.unite,
  } as unknown as DerogationRow;
}

const DEROGATION_SORT_COLUMNS: Record<ListDerogationsQueryDTO["sortBy"], string> = {
  code: "d.code",
  status: "d.status",
  valid_to: "d.valid_to",
  updated_at: "d.updated_at",
};

export async function repoListDerogations(
  filters: ListDerogationsQueryDTO
): Promise<{ items: unknown[]; total: number }> {
  const clauses: string[] = ["TRUE"];
  const values: unknown[] = [];
  const push = (sql: string, value: unknown) => {
    values.push(value);
    clauses.push(sql.replace(/\$\?/g, `$${values.length}`));
  };

  if (filters.q) push("(d.code ILIKE $? OR d.requirement ILIKE $?)", `%${filters.q}%`);
  if (filters.status) push("d.status = $?", filters.status);
  if (filters.non_conformity_id) push("d.non_conformity_id = $?::uuid", filters.non_conformity_id);
  if (filters.lot_id) push("d.lot_id = $?::uuid", filters.lot_id);
  if (filters.expiring_within_days) {
    push("(d.valid_to IS NOT NULL AND d.valid_to <= now() + ($? || ' days')::interval)", String(filters.expiring_within_days));
  }

  const whereSql = clauses.join(" AND ");

  const totalRes = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM public.quality_derogation d WHERE ${whereSql}`,
    values
  );
  const itemsRes = await pool.query(
    `
      SELECT d.id, d.code, d.status, d.derogation_type, d.non_conformity_id,
             d.article_id, d.piece_technique_id, d.piece_version_id, d.lot_id,
             d.requirement, d.deviation, d.max_qty, d.unite, d.consumed_qty,
             d.valid_from, d.valid_to, d.requested_by, d.approved_by, d.approved_at,
             d.created_at, d.updated_at,
             GREATEST(COALESCE(d.max_qty, 0) - d.consumed_qty, 0) AS remaining_qty
      FROM public.quality_derogation d
      WHERE ${whereSql}
      ORDER BY ${DEROGATION_SORT_COLUMNS[filters.sortBy]} ${sortDirection(filters.sortDir)} NULLS LAST, d.code ASC
      LIMIT ${filters.pageSize} OFFSET ${(filters.page - 1) * filters.pageSize}
    `,
    values
  );
  return { items: itemsRes.rows, total: totalRes.rows[0]?.total ?? 0 };
}

export async function repoGetDerogation(id: string): Promise<{
  derogation: DerogationRow;
  consumptions: unknown[];
} | null> {
  const derogation = await loadDerogation(pool, id);
  if (!derogation) return null;
  const consumptions = await pool.query(
    `
      SELECT id, qty, unite, quality_control_id, release_decision_id, bon_livraison_id,
             actor_user_id, created_at, context
      FROM public.quality_derogation_consumption
      WHERE derogation_id = $1::uuid
      ORDER BY created_at DESC
    `,
    [id]
  );
  return { derogation, consumptions: consumptions.rows };
}

export async function repoCreateDerogation(params: {
  body: CreateDerogationBodyDTO;
  actor: QualityActor;
}): Promise<DerogationRow> {
  return withTransaction(async (client) => {
    const code = await generateTransactionalBusinessCode(client, { prefix: "DER" });
    const insert = await client.query<{ id: string; correlation_id: string }>(
      `
        INSERT INTO public.quality_derogation (
          code, derogation_type, status, non_conformity_id, client_id, fournisseur_id,
          article_id, piece_technique_id, piece_version_id, lot_id, of_id, commande_id, bon_livraison_id,
          requirement, deviation, risk_analysis, conditions,
          max_qty, unite, valid_from, valid_to, customer_agreement_reference,
          requested_by, created_by, updated_by
        )
        VALUES (
          $1, $2, 'DRAFT', $3::uuid, $4, $5::uuid,
          $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10, $11::uuid, $12::uuid,
          $13, $14, $15, $16,
          $17, $18, $19::timestamptz, $20::timestamptz, $21,
          $22, $22, $22
        )
        RETURNING id, correlation_id
      `,
      [
        code,
        params.body.derogation_type,
        params.body.non_conformity_id ?? null,
        params.body.client_id ?? null,
        params.body.fournisseur_id ?? null,
        params.body.article_id ?? null,
        params.body.piece_technique_id ?? null,
        params.body.piece_version_id ?? null,
        params.body.lot_id ?? null,
        params.body.of_id ?? null,
        params.body.commande_id ?? null,
        params.body.bon_livraison_id ?? null,
        params.body.requirement,
        params.body.deviation,
        params.body.risk_analysis ?? null,
        params.body.conditions ?? null,
        params.body.max_qty ?? null,
        params.body.unite ?? null,
        params.body.valid_from ?? null,
        params.body.valid_to ?? null,
        params.body.customer_agreement_reference ?? null,
        params.actor.user_id,
      ]
    );
    const id = insert.rows[0]!.id;

    await insertQualityEvent(client, {
      entity_type: "DEROGATION",
      entity_id: id,
      event_type: "DEROGATION_CREATED",
      actor: params.actor,
      old_values: null,
      new_values: { code, status: "DRAFT", requirement: params.body.requirement },
      correlation_id: insert.rows[0]!.correlation_id,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.derogations.create",
      entity_type: "quality_derogation",
      entity_id: id,
      details: { code },
    });

    return (await loadDerogation(client, id))!;
  });
}

export async function repoTransitionDerogation(params: {
  id: string;
  body: DerogationTransitionBodyDTO;
  actor: QualityActor;
}): Promise<DerogationRow | null> {
  return withTransaction(async (client) => {
    const before = await loadDerogation(client, params.id, true);
    if (!before) return null;

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: before.updated_at,
    });
    assertDerogationTransition(
      before.status as QualityDerogationStatus,
      params.body.target_status as QualityDerogationStatus
    );

    if (params.body.target_status === "APPROVED") {
      assertDerogationApprovalSeparation({
        requesterUserId: before.requested_by,
        approverUserId: params.actor.user_id,
      });
    }

    const setters: Record<QualityDerogationStatus, string> = {
      DRAFT: "submitted_at = NULL",
      SUBMITTED: "submitted_at = now()",
      APPROVED: "approved_at = now(), approved_by = $3",
      REJECTED: "rejected_at = now(), rejected_by = $3, rejection_reason = $4",
      CONSUMED: "updated_at = now()",
      EXPIRED: "updated_at = now()",
      REVOKED: "revoked_at = now(), revoked_by = $3, revocation_reason = $4",
    };

    await client.query(
      `
        UPDATE public.quality_derogation
        SET status = $2, ${setters[params.body.target_status as QualityDerogationStatus]}, updated_by = $3
        WHERE id = $1::uuid
      `,
      [params.id, params.body.target_status, params.actor.user_id, params.body.reason ?? null]
    );

    await insertQualityEvent(client, {
      entity_type: "DEROGATION",
      entity_id: params.id,
      event_type: `DEROGATION_${params.body.target_status}`,
      actor: params.actor,
      old_values: { status: before.status },
      new_values: { status: params.body.target_status },
      correlation_id: params.id,
      rule_code: "QUALITY_DEROGATION_TRANSITION",
      reason: params.body.reason ?? null,
    });
    await insertAuditLog(client, params.actor, {
      action: `qualite.derogations.${params.body.target_status.toLowerCase()}`,
      entity_type: "quality_derogation",
      entity_id: params.id,
      details: { from: before.status, to: params.body.target_status, reason: params.body.reason ?? null },
    });

    return (await loadDerogation(client, params.id))!;
  });
}

async function consumeDerogationInternal(
  tx: DbQueryer,
  params: {
    derogationId: string;
    qty: number;
    unite: string;
    actor: QualityActor;
    releaseDecisionId: string | null;
    qualityControlId: string | null;
    bonLivraisonId?: string | null;
    idempotencyKey: string | null;
    context: Record<string, unknown>;
  }
): Promise<string> {
  const res = await tx.query<{ id: string }>(
    `
      INSERT INTO public.quality_derogation_consumption (
        derogation_id, quality_control_id, release_decision_id, bon_livraison_id,
        qty, unite, context, actor_user_id, idempotency_key
      )
      VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::jsonb, $8, $9)
      RETURNING id
    `,
    [
      params.derogationId,
      params.qualityControlId,
      params.releaseDecisionId,
      params.bonLivraisonId ?? null,
      params.qty,
      params.unite,
      JSON.stringify(params.context),
      params.actor.user_id,
      params.idempotencyKey,
    ]
  );

  const totals = await tx.query<{ consumed: string; max_qty: string | null }>(
    `
      SELECT COALESCE(SUM(c.qty), 0)::text AS consumed, d.max_qty::text AS max_qty
      FROM public.quality_derogation d
      LEFT JOIN public.quality_derogation_consumption c ON c.derogation_id = d.id
      WHERE d.id = $1::uuid
      GROUP BY d.max_qty
    `,
    [params.derogationId]
  );
  const consumed = toNumber(totals.rows[0]?.consumed);
  const maxQty = totals.rows[0]?.max_qty === null || totals.rows[0]?.max_qty === undefined ? null : Number(totals.rows[0].max_qty);

  await tx.query(
    `UPDATE public.quality_derogation SET consumed_qty = $2, status = $3, updated_by = $4 WHERE id = $1::uuid`,
    [
      params.derogationId,
      consumed,
      derogationStatusAfterConsumption({ max_qty: maxQty, consumed_qty: consumed }),
      params.actor.user_id,
    ]
  );

  return res.rows[0]!.id;
}

export async function repoConsumeDerogation(params: {
  id: string;
  body: ConsumeDerogationBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<{ consumption_id: string; derogation: DerogationRow } | null> {
  return withTransaction(async (client) => {
    const derogation = await loadDerogation(client, params.id, true);
    if (!derogation) return null;

    const idem = await acquireIdempotency({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "quality.derogation.consume",
      requestPayload: { id: params.id, ...params.body },
    });
    if (idem.replay) {
      return {
        consumption_id: String(idem.replay.consumption_id),
        derogation: (await loadDerogation(client, params.id))!,
      };
    }

    const usage = evaluateDerogationUsage({
      derogation,
      context: {
        article_id: null,
        piece_technique_id: null,
        piece_version_id: null,
        lot_id: derogation.lot_id,
        of_id: derogation.of_id,
        commande_id: derogation.commande_id,
        bon_livraison_id: params.body.bon_livraison_id ?? derogation.bon_livraison_id,
        unit: params.body.unite,
      },
      qty: params.body.qty,
      at: new Date(),
    });
    if (!usage.allowed) {
      throw new HttpError(409, usage.code, usage.message, { derogation_id: params.id });
    }

    const consumptionId = await consumeDerogationInternal(client, {
      derogationId: params.id,
      qty: params.body.qty,
      unite: params.body.unite,
      actor: params.actor,
      releaseDecisionId: params.body.release_decision_id ?? null,
      qualityControlId: params.body.quality_control_id ?? null,
      bonLivraisonId: params.body.bon_livraison_id ?? null,
      idempotencyKey: idem.idempotencyKey,
      context: params.body.context,
    });

    await insertQualityEvent(client, {
      entity_type: "DEROGATION",
      entity_id: params.id,
      event_type: "DEROGATION_CONSUMED",
      actor: params.actor,
      old_values: { consumed_qty: derogation.consumed_qty },
      new_values: { consumption_id: consumptionId, qty: params.body.qty },
      correlation_id: params.id,
      idempotency_key: idem.idempotencyKey,
      rule_code: "QUALITY_DEROGATION_CONSUMPTION",
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.derogations.consume",
      entity_type: "quality_derogation",
      entity_id: params.id,
      details: { qty: params.body.qty, unite: params.body.unite },
    });
    await saveReceipt({
      client,
      actor: params.actor,
      idempotencyKey: idem.idempotencyKey,
      requestHash: idem.requestHash,
      commandType: "quality.derogation.consume",
      aggregateType: "DEROGATION",
      aggregateId: params.id,
      requestPayload: { id: params.id, ...params.body },
      resultPayload: { consumption_id: consumptionId },
      correlationId: params.id,
    });

    return { consumption_id: consumptionId, derogation: (await loadDerogation(client, params.id))! };
  });
}

/* ========================================================================== */
/* Non-conformités : analyse guidée et transitions étendues                    */
/* ========================================================================== */

export async function repoUpsertNcAnalysis(params: {
  id: string;
  body: UpsertAnalysisBodyDTO;
  actor: QualityActor;
}): Promise<{ steps: unknown[] } | null> {
  return withTransaction(async (client) => {
    const before = await client.query<{ id: string; updated_at: string; status: string }>(
      `SELECT id, updated_at, status::text AS status FROM public.non_conformity WHERE id = $1::uuid FOR UPDATE`,
      [params.id]
    );
    const nc = before.rows[0];
    if (!nc) return null;

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: nc.updated_at,
    });
    if (nc.status === "CLOSED" || nc.status === "CANCELLED") {
      throw new HttpError(
        409,
        "QUALITY_NC_CLOSED",
        "Une non-conformité clôturée ou annulée ne se modifie pas : réouvrez-la."
      );
    }

    const positions = new Set<number>();
    const codes = new Set<string>();
    for (const step of params.body.steps) {
      if (step.method !== params.body.method) {
        throw new HttpError(
          422,
          "QUALITY_ANALYSIS_METHOD_MISMATCH",
          "Toutes les étapes doivent appartenir à la méthode demandée."
        );
      }
      if (positions.has(step.position)) {
        throw new HttpError(422, "QUALITY_ANALYSIS_POSITION_DUPLICATE", `Position dupliquée : ${step.position}.`);
      }
      if (codes.has(step.step_code)) {
        throw new HttpError(422, "QUALITY_ANALYSIS_STEP_DUPLICATE", `Étape dupliquée : ${step.step_code}.`);
      }
      positions.add(step.position);
      codes.add(step.step_code);
    }

    for (const step of params.body.steps) {
      await client.query(
        `
          INSERT INTO public.non_conformity_analysis (
            non_conformity_id, method, step_code, position, question, answer,
            owner_user_id, due_date, completed_at, completed_by, created_by, updated_by
          )
          VALUES (
            $1::uuid, $2, $3, $4, $5, $6,
            $7, $8::date,
            CASE WHEN $9 THEN now() ELSE NULL END,
            CASE WHEN $9 THEN $10 ELSE NULL END,
            $10, $10
          )
          ON CONFLICT (non_conformity_id, method, step_code) DO UPDATE
          SET position = EXCLUDED.position,
              question = EXCLUDED.question,
              answer = EXCLUDED.answer,
              owner_user_id = EXCLUDED.owner_user_id,
              due_date = EXCLUDED.due_date,
              completed_at = EXCLUDED.completed_at,
              completed_by = EXCLUDED.completed_by,
              updated_by = EXCLUDED.updated_by
        `,
        [
          params.id,
          step.method,
          step.step_code,
          step.position,
          step.question,
          step.answer,
          step.owner_user_id,
          step.due_date,
          step.completed,
          params.actor.user_id,
        ]
      );
    }

    await client.query(`UPDATE public.non_conformity SET updated_by = $2 WHERE id = $1::uuid`, [
      params.id,
      params.actor.user_id,
    ]);

    await insertQualityEvent(client, {
      entity_type: "NON_CONFORMITY",
      entity_id: params.id,
      event_type: `ANALYSIS_${params.body.method}`,
      actor: params.actor,
      old_values: null,
      new_values: { method: params.body.method, steps: params.body.steps.length },
      correlation_id: params.id,
    });
    await insertAuditLog(client, params.actor, {
      action: "qualite.nc.analysis",
      entity_type: "non_conformity",
      entity_id: params.id,
      details: { method: params.body.method, steps: params.body.steps.length },
    });

    const steps = await client.query(
      `
        SELECT id, method, step_code, position, question, answer, owner_user_id,
               due_date, completed_at, completed_by, created_at, updated_at
        FROM public.non_conformity_analysis
        WHERE non_conformity_id = $1::uuid
        ORDER BY method ASC, position ASC
      `,
      [params.id]
    );
    return { steps: steps.rows };
  });
}

export async function repoGetNcAnalysis(id: string): Promise<unknown[]> {
  const res = await pool.query(
    `
      SELECT id, method, step_code, position, question, answer, owner_user_id,
             due_date, completed_at, completed_by, created_at, updated_at
      FROM public.non_conformity_analysis
      WHERE non_conformity_id = $1::uuid
      ORDER BY method ASC, position ASC
    `,
    [id]
  );
  return res.rows;
}

export async function repoTransitionNc(params: {
  id: string;
  body: NcTransitionBodyDTO;
  actor: QualityActor;
}): Promise<{ id: string; status: string } | null> {
  return withTransaction(async (client) => {
    const before = await client.query<{
      id: string;
      status: string;
      updated_at: string;
      root_cause: string | null;
      capa_required: boolean;
    }>(
      `
        SELECT id, status::text AS status, updated_at, root_cause, capa_required
        FROM public.non_conformity WHERE id = $1::uuid FOR UPDATE
      `,
      [params.id]
    );
    const nc = before.rows[0];
    if (!nc) return null;

    assertOptimisticVersion({
      expectedUpdatedAt: params.body.expected_updated_at,
      currentUpdatedAt: nc.updated_at,
    });
    assertNcTransition(nc.status as QualityNcStatus, params.body.target_status as QualityNcStatus);

    if (params.body.target_status === "CLOSED") {
      const checks = await client.query<{
        dispositions: number;
        mandatory_capa: number;
        verified_capa: number;
        evidence: number;
      }>(
        `
          SELECT
            (SELECT COUNT(*)::int FROM public.non_conformity_dispositions WHERE non_conformity_id = $1::uuid) AS dispositions,
            (SELECT COUNT(*)::int FROM public.quality_action WHERE non_conformity_id = $1::uuid AND mandatory) AS mandatory_capa,
            (SELECT COUNT(*)::int FROM public.quality_action WHERE non_conformity_id = $1::uuid AND mandatory AND status = 'VERIFIED') AS verified_capa,
            (SELECT COUNT(*)::int FROM public.quality_documents WHERE entity_type = 'NON_CONFORMITY' AND entity_id = $1::uuid AND removed_at IS NULL) AS evidence
        `,
        [params.id]
      );
      const row = checks.rows[0]!;
      assertNcClosureAllowed({
        hasDisposition: row.dispositions > 0,
        mandatoryCapaCount: row.mandatory_capa,
        verifiedCapaCount: row.verified_capa,
        hasRootCause: Boolean((nc.root_cause ?? "").trim()),
        hasEffectivenessEvidence: row.evidence > 0,
      });
    }

    const extras: Record<string, string> = {
      CLOSED: "closed_at = now(), closed_by = $3",
      CANCELLED: "cancelled_at = now(), cancelled_by = $3, cancellation_reason = $4",
      OPEN: nc.status === "CLOSED" ? "reopened_at = now(), reopened_by = $3, reopen_reason = $4, closed_at = NULL, closed_by = NULL" : "updated_at = now()",
    };

    await client.query(
      `
        UPDATE public.non_conformity
        SET status = $2::public.quality_nc_status,
            ${extras[params.body.target_status] ?? "updated_at = now()"},
            updated_by = $3
        WHERE id = $1::uuid
      `,
      [params.id, params.body.target_status, params.actor.user_id, params.body.reason ?? null]
    );

    await insertQualityEvent(client, {
      entity_type: "NON_CONFORMITY",
      entity_id: params.id,
      event_type: `NC_${params.body.target_status}`,
      actor: params.actor,
      old_values: { status: nc.status },
      new_values: { status: params.body.target_status },
      correlation_id: params.id,
      rule_code: "QUALITY_NC_TRANSITION",
      reason: params.body.reason ?? null,
    });
    await insertAuditLog(client, params.actor, {
      action: `qualite.nc.${params.body.target_status.toLowerCase()}`,
      entity_type: "non_conformity",
      entity_id: params.id,
      details: { from: nc.status, to: params.body.target_status, reason: params.body.reason ?? null },
    });

    return { id: params.id, status: params.body.target_status };
  });
}

/* ========================================================================== */
/* Éligibilité et centre Qualité                                              */
/* ========================================================================== */

export async function repoEvaluateEligibility(
  query: EligibilityQueryDTO
): Promise<{ target: EligibilityTarget; verdict: ReturnType<typeof evaluateQualityEligibility> }> {
  const lotRes =
    query.object_type === "LOT"
      ? await pool.query<{ lot_code: string | null; lot_status: string | null }>(
          `SELECT lot_code, lot_status FROM public.lots WHERE id = $1::uuid`,
          [query.object_id]
        )
      : { rows: [] as Array<{ lot_code: string | null; lot_status: string | null }> };

  const aggregates = await pool.query<{
    qty_released: string;
    qty_held: string;
    qty_consumed: string;
    pending_controls: number;
  }>(
    `
      SELECT COALESCE(SUM(qty_released), 0)::text AS qty_released,
             COALESCE(SUM(qty_held), 0)::text AS qty_held,
             COALESCE(SUM(qty_consumed), 0)::text AS qty_consumed,
             COUNT(*) FILTER (WHERE validation_date IS NULL)::int AS pending_controls
      FROM public.quality_control
      WHERE source_type = $1 AND source_id = $2
    `,
    [query.object_type, query.object_id]
  );

  // Les NC ouvertes ne bloquent que l'objet exact auquel elles sont rattachées :
  // pas de blocage global d'articles non concernés.
  const ncRes =
    query.object_type === "LOT"
      ? await pool.query<{ total: number }>(
          `
            SELECT COUNT(*)::int AS total
            FROM public.non_conformity nc
            WHERE nc.status::text NOT IN ('CLOSED', 'CANCELLED')
              AND nc.lot_id = $1::uuid
              AND NOT EXISTS (
                SELECT 1 FROM public.non_conformity_dispositions d WHERE d.non_conformity_id = nc.id
              )
          `,
          [query.object_id]
        )
      : { rows: [{ total: 0 }] };

  const agg = aggregates.rows[0];
  const target: EligibilityTarget = {
    object_type: query.object_type,
    object_id: query.object_id,
    label: lotRes.rows[0]?.lot_code ?? null,
    qty_requested: query.qty,
    lot_status: (lotRes.rows[0]?.lot_status ?? null) as EligibilityTarget["lot_status"],
    qty_released: toNumber(agg?.qty_released),
    qty_held: toNumber(agg?.qty_held),
    qty_consumed: toNumber(agg?.qty_consumed),
    open_nc_without_disposition: ncRes.rows[0]?.total ?? 0,
    pending_mandatory_controls: agg?.pending_controls ?? 0,
    derogation: null,
  };

  return {
    target,
    verdict: evaluateQualityEligibility(target, query.purpose as QualityEligibilityPurpose, new Date()),
  };
}

export type QualityCenter = {
  queues: {
    to_control: number;
    awaiting_decision: number;
    quarantine_lots: number;
    open_non_conformities: number;
    overdue_capa: number;
    derogations_to_approve: number;
    derogations_expiring: number;
    snapshot_integrity_alerts: number;
  };
};

export async function repoQualityCenter(params: { horizonDays: number }): Promise<QualityCenter> {
  const res = await pool.query<{
    to_control: number;
    awaiting_decision: number;
    quarantine_lots: number;
    open_non_conformities: number;
    overdue_capa: number;
    derogations_to_approve: number;
    derogations_expiring: number;
  }>(
    `
      SELECT
        (SELECT COUNT(*)::int FROM public.quality_control
          WHERE status IN ('PLANNED', 'IN_PROGRESS')) AS to_control,
        (SELECT COUNT(*)::int FROM public.quality_control
          WHERE validation_date IS NULL AND verdict_computed IS NOT NULL AND verdict_computed <> 'EN_ATTENTE') AS awaiting_decision,
        (SELECT COUNT(*)::int FROM public.lots
          WHERE lot_status IN ('QUARANTAINE', 'EN_ATTENTE', 'BLOQUE')) AS quarantine_lots,
        (SELECT COUNT(*)::int FROM public.non_conformity
          WHERE status::text NOT IN ('CLOSED', 'CANCELLED')) AS open_non_conformities,
        (SELECT COUNT(*)::int FROM public.quality_action
          WHERE status <> 'VERIFIED' AND due_date IS NOT NULL AND due_date < CURRENT_DATE) AS overdue_capa,
        (SELECT COUNT(*)::int FROM public.quality_derogation
          WHERE status = 'SUBMITTED') AS derogations_to_approve,
        (SELECT COUNT(*)::int FROM public.quality_derogation
          WHERE status = 'APPROVED' AND valid_to IS NOT NULL
            AND valid_to <= now() + ($1 || ' days')::interval) AS derogations_expiring
    `,
    [String(params.horizonDays)]
  );

  // Alertes d'intégrité : contrôles dont le snapshot ne correspond plus à son
  // empreinte. Le calcul est fait en TypeScript avec le même JSON canonique.
  const snapshots = await pool.query<{ id: string; plan_snapshot: unknown; plan_snapshot_sha256: string }>(
    `
      SELECT id, plan_snapshot, plan_snapshot_sha256
      FROM public.quality_control
      WHERE plan_snapshot_sha256 IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 500
    `
  );
  let integrityAlerts = 0;
  for (const row of snapshots.rows) {
    if (qualitySha256(row.plan_snapshot) !== row.plan_snapshot_sha256) integrityAlerts += 1;
  }

  const row = res.rows[0]!;
  return {
    queues: {
      to_control: row.to_control,
      awaiting_decision: row.awaiting_decision,
      quarantine_lots: row.quarantine_lots,
      open_non_conformities: row.open_non_conformities,
      overdue_capa: row.overdue_capa,
      derogations_to_approve: row.derogations_to_approve,
      derogations_expiring: row.derogations_expiring,
      snapshot_integrity_alerts: integrityAlerts,
    },
  };
}
