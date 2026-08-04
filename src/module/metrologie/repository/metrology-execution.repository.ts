// Exécutions métrologiques et preuves documentaires (#229).
//
// La transaction « hors tolérance » vit ici : verrouillage, événement
// append-only, quarantaine de l'instrument, analyse d'impact bornée, audit —
// le tout dans UN SEUL commit. Un échec ne laisse ni double certificat, ni
// double quarantaine, ni double dossier d'impact.

import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";

import { generateMetrologieExecutionCode } from "../../../shared/codes/code-generator.service";
import { registerUploadDestination } from "../../../shared/uploads/secure-upload";
import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import { HttpError } from "../../../utils/httpError";

import {
  assertExecutionMutable,
  assertExecutionTransition,
  assertManualVerdictOverride,
  assertOptimisticVersion,
  assertPlanSelectableForExecution,
  assertVerdictSeparation,
  metrologySha256,
  verdictIsAdmissibleProof,
  verdictToLegacyCertificatResult,
  verdictTriggersQuarantine,
  type MetrologyOperationType,
  type MetrologyVerdict,
} from "../domain/metrology-policy";
import {
  assertScheduleOverrideAllowed,
  computeNextDueDate,
  type PeriodicityUnit,
} from "../domain/metrology-schedule";
import { computeExecutionVerdict, type MeasurementInput } from "../domain/metrology-verdict";
import type {
  CancelCertificateBodyDTO,
  CancelExecutionBodyDTO,
  CreateExecutionBodyDTO,
  ListExecutionsQueryDTO,
  RecordMeasurementsBodyDTO,
  UploadCertificateBodyDTO,
  ValidateExecutionBodyDTO,
} from "../validators/metrology-360.validators";
import type {
  MetrologyCertificateDTO,
  MetrologyExecutionDTO,
  MetrologyExecutionListItemDTO,
  MetrologyVerdictPreviewDTO,
  Paginated,
  UserRef,
} from "../types/metrology-360.types";
import {
  acquireIdempotency,
  db,
  insertAuditLog,
  insertMetrologyEvent,
  isRecord,
  rethrowMapped,
  saveReceipt,
  sortDirection,
  toInt,
  toNumber,
  withTransaction,
  type MetrologyActor,
} from "./metrology-shared.repository";
import { monthsFromPeriodicity, syncLegacyPlan } from "./metrology-registry.repository";
import { openImpactDossier } from "./metrology-impact.repository";

function mapUserRef(row: {
  id: number | null;
  username: string | null;
  name: string | null;
  surname: string | null;
}): UserRef | null {
  if (!row.id || !row.username) return null;
  const parts = [row.surname ?? "", row.name ?? ""].map((s) => s.trim()).filter(Boolean);
  return { id: row.id, username: row.username, label: parts.join(" ").trim() || row.username };
}

/* ========================================================================== */
/* Chargement                                                                 */
/* ========================================================================== */

type ExecutionLock = {
  id: string;
  code: string;
  equipement_id: string;
  operation_type: MetrologyOperationType;
  status: "DRAFT" | "IN_PROGRESS" | "VALIDATED" | "CANCELLED";
  plan_version_id: string | null;
  operator_user_id: number | null;
  started_at: string;
  updated_at: string;
};

async function lockExecution(client: PoolClient, id: string): Promise<ExecutionLock> {
  const res = await client.query<ExecutionLock>(
    `
      SELECT id::text AS id, code, equipement_id::text AS equipement_id, operation_type, status,
             plan_version_id::text AS plan_version_id, operator_user_id,
             started_at::text AS started_at, updated_at::text AS updated_at
      FROM public.metrologie_execution
      WHERE id = $1::uuid
      FOR UPDATE
    `,
    [id]
  );
  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(404, "NOT_FOUND", "Exécution métrologique introuvable.");
  return row;
}

type PlanContext = {
  id: string;
  version: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  operation_type: "ETALONNAGE" | "VERIFICATION";
  tolerance_min: number | null;
  tolerance_max: number | null;
  unite: string | null;
  min_points: number | null;
  periodicite_valeur: number;
  periodicite_unite: PeriodicityUnit;
  base_calcul: "LAST_PROOF" | "FIXED_DATE";
  alert_window_days: number;
  effective_from: string | null;
  exige_certificat: boolean;
  criticite: "NORMAL" | "CRITIQUE";
  role_habilite: string | null;
};

async function loadPlanContext(
  q: Pick<PoolClient, "query">,
  planVersionId: string,
  equipementId: string
): Promise<PlanContext> {
  const res = await q.query<Record<string, unknown>>(
    `
      SELECT id::text AS id, version, status, operation_type,
             tolerance_min::text AS tolerance_min, tolerance_max::text AS tolerance_max,
             unite, criteres, periodicite_valeur, periodicite_unite, base_calcul,
             alert_window_days, effective_from::text AS effective_from,
             exige_certificat, criticite, role_habilite
      FROM public.metrologie_plan_version
      WHERE id = $1::uuid AND equipement_id = $2::uuid
    `,
    [planVersionId, equipementId]
  );
  const row = res.rows[0] ?? null;
  if (!row) throw new HttpError(404, "NOT_FOUND", "Version de plan introuvable pour cet équipement.");
  const criteres = isRecord(row.criteres) ? row.criteres : {};
  return {
    id: String(row.id),
    version: toInt(row.version, 1),
    status: row.status as PlanContext["status"],
    operation_type: row.operation_type as PlanContext["operation_type"],
    tolerance_min: toNumber(row.tolerance_min),
    tolerance_max: toNumber(row.tolerance_max),
    unite: (row.unite ?? null) as string | null,
    min_points: toNumber(criteres.min_points),
    periodicite_valeur: toInt(row.periodicite_valeur, 12),
    periodicite_unite: row.periodicite_unite as PeriodicityUnit,
    base_calcul: row.base_calcul as PlanContext["base_calcul"],
    alert_window_days: toInt(row.alert_window_days, 30),
    effective_from: (row.effective_from ?? null) as string | null,
    exige_certificat: row.exige_certificat === true,
    criticite: row.criticite as PlanContext["criticite"],
    role_habilite: (row.role_habilite ?? null) as string | null,
  };
}

async function loadMeasurements(
  q: Pick<PoolClient, "query">,
  executionId: string
): Promise<MeasurementInput[]> {
  const res = await q.query<Record<string, unknown>>(
    `
      SELECT point_key, sample_no, nominal::text AS nominal,
             tolerance_min::text AS tolerance_min, tolerance_max::text AS tolerance_max,
             measured::text AS measured, unite, incertitude::text AS incertitude
      FROM public.metrologie_execution_measurement
      WHERE execution_id = $1::uuid
      ORDER BY point_key, sample_no
    `,
    [executionId]
  );
  return res.rows.map((row) => ({
    point_key: String(row.point_key),
    sample_no: toInt(row.sample_no, 1),
    nominal: toNumber(row.nominal),
    tolerance_min: toNumber(row.tolerance_min),
    tolerance_max: toNumber(row.tolerance_max),
    measured: toNumber(row.measured),
    unite: (row.unite ?? null) as string | null,
    incertitude: toNumber(row.incertitude),
  }));
}

/* ========================================================================== */
/* Création et saisie                                                         */
/* ========================================================================== */

export async function repoCreateExecution(params: {
  equipementId: string;
  body: CreateExecutionBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyExecutionDTO> {
  const { equipementId, body, actor } = params;
  const executionId = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.execution.create",
      requestPayload: { equipementId, ...body },
    });
    if (claim.replay && typeof claim.replay.id === "string") return claim.replay.id;

    const equip = await client.query<{ id: string; etat: string; designation: string }>(
      `SELECT id::text AS id, etat, designation FROM public.metrologie_equipements
        WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
      [equipementId]
    );
    if (!equip.rows[0]) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");
    if (equip.rows[0].etat === "RETIRED") {
      throw new HttpError(
        409,
        "METROLOGY_EQUIPMENT_RETIRED",
        "Un équipement retiré ne reçoit plus d'étalonnage ni de vérification."
      );
    }

    let planVersion: number | null = null;
    if (body.plan_version_id) {
      const plan = await loadPlanContext(client, body.plan_version_id, equipementId);
      assertPlanSelectableForExecution(plan.status);
      if (plan.operation_type !== body.operation_type && body.operation_type !== "AJUSTAGE" && body.operation_type !== "REPARATION") {
        throw new HttpError(
          422,
          "METROLOGY_PLAN_OPERATION_MISMATCH",
          `Cette version de plan couvre ${plan.operation_type}, pas ${body.operation_type}.`
        );
      }
      planVersion = plan.version;
    }

    const code = await generateMetrologieExecutionCode(client, {
      date: body.started_at ? new Date(body.started_at) : new Date(),
    });

    let newId: string;
    try {
      const ins = await client.query<{ id: string }>(
        `
          INSERT INTO public.metrologie_execution (
            code, equipement_id, plan_version_id, plan_version, operation_type, status,
            started_at, operator_user_id, provider_label, fournisseur_id,
            methode, procedure_ref, etalon_reference, environnement, observations,
            correlation_id, created_by, updated_by
          )
          VALUES (
            $1,$2::uuid,$3::uuid,$4,$5,'IN_PROGRESS',
            COALESCE($6::timestamptz, now()),$7,$8,$9::uuid,
            $10,$11,$12,$13::jsonb,$14,
            $15::uuid,$16,$16
          )
          RETURNING id::text AS id
        `,
        [
          code,
          equipementId,
          body.plan_version_id ?? null,
          planVersion,
          body.operation_type,
          body.started_at ?? null,
          body.operator_user_id ?? actor.user_id,
          body.provider_label,
          body.fournisseur_id ?? null,
          body.methode,
          body.procedure_ref,
          body.etalon_reference,
          JSON.stringify(body.environnement ?? {}),
          body.observations,
          crypto.randomUUID(),
          actor.user_id,
        ]
      );
      newId = ins.rows[0]?.id ?? "";
    } catch (err) {
      rethrowMapped(err);
    }
    if (!newId) throw new HttpError(500, "METROLOGY_EXECUTION_CREATE_FAILED", "Création impossible.");

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: equipementId,
      entity_type: "EXECUTION",
      entity_id: newId,
      event_type: "EXECUTION_OPENED",
      actor,
      old_values: null,
      new_values: { code, operation_type: body.operation_type, plan_version_id: body.plan_version_id ?? null },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.executions.create",
      entity_type: "metrologie_execution",
      entity_id: newId,
      details: { code, equipement_id: equipementId, operation_type: body.operation_type },
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.execution.create",
      aggregateType: "EXECUTION",
      aggregateId: newId,
      requestPayload: { equipementId, ...body },
      resultPayload: { id: newId, code },
      correlationId,
    });
    return newId;
  });

  const detail = await repoGetExecution(executionId);
  if (!detail) throw new HttpError(500, "METROLOGY_EXECUTION_RELOAD_FAILED", "Exécution introuvable après création.");
  return detail;
}

export async function repoRecordMeasurements(params: {
  executionId: string;
  body: RecordMeasurementsBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyExecutionDTO> {
  const { executionId, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.execution.measurements",
      requestPayload: { executionId, ...body },
    });
    if (claim.replay) return;

    const execution = await lockExecution(client, executionId);
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: execution.updated_at,
    });
    assertExecutionMutable(execution.status);

    for (const measurement of body.measurements) {
      const existing = await client.query<{
        id: string;
        revision: number;
        nominal: string | null;
        tolerance_min: string | null;
        tolerance_max: string | null;
        measured: string | null;
        unite: string | null;
      }>(
        `
          SELECT id::text AS id, revision, nominal::text AS nominal,
                 tolerance_min::text AS tolerance_min, tolerance_max::text AS tolerance_max,
                 measured::text AS measured, unite
          FROM public.metrologie_execution_measurement
          WHERE execution_id = $1::uuid AND point_key = $2 AND sample_no = $3
          FOR UPDATE
        `,
        [executionId, measurement.point_key, measurement.sample_no]
      );
      const current = existing.rows[0] ?? null;

      if (current) {
        // Corriger un relevé déjà saisi exige un motif : on empile une révision
        // append-only, on n'écrase jamais silencieusement une valeur mesurée.
        if (!measurement.revision_reason) {
          throw new HttpError(
            422,
            "METROLOGY_MEASUREMENT_REVISION_REASON_REQUIRED",
            `Corriger le point ${measurement.point_key} (échantillon ${measurement.sample_no}) exige un motif.`,
            { fields: { revision_reason: ["Motif de correction obligatoire."] } }
          );
        }
        await client.query(
          `
            INSERT INTO public.metrologie_measurement_revision (
              measurement_id, revision, previous_values, reason, created_by
            )
            VALUES ($1::uuid, $2, $3::jsonb, $4, $5)
          `,
          [
            current.id,
            current.revision,
            JSON.stringify({
              nominal: current.nominal,
              tolerance_min: current.tolerance_min,
              tolerance_max: current.tolerance_max,
              measured: current.measured,
              unite: current.unite,
            }),
            measurement.revision_reason,
            actor.user_id,
          ]
        );
        await client.query(
          `
            UPDATE public.metrologie_execution_measurement
            SET label = $2, nominal = $3, tolerance_min = $4, tolerance_max = $5,
                measured = $6, unite = $7, incertitude = $8, comment = $9,
                revision = revision + 1, updated_at = now(), updated_by = $10
            WHERE id = $1::uuid
          `,
          [
            current.id,
            measurement.label,
            measurement.nominal,
            measurement.tolerance_min,
            measurement.tolerance_max,
            measurement.measured,
            measurement.unite,
            measurement.incertitude,
            measurement.comment,
            actor.user_id,
          ]
        );
        continue;
      }

      await client.query(
        `
          INSERT INTO public.metrologie_execution_measurement (
            execution_id, point_key, sample_no, label, nominal,
            tolerance_min, tolerance_max, measured, unite, incertitude, comment,
            created_by, updated_by
          )
          VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
        `,
        [
          executionId,
          measurement.point_key,
          measurement.sample_no,
          measurement.label,
          measurement.nominal,
          measurement.tolerance_min,
          measurement.tolerance_max,
          measurement.measured,
          measurement.unite,
          measurement.incertitude,
          measurement.comment,
          actor.user_id,
        ]
      );
    }

    // Verdict recalculé et écart persistés à chaque saisie : la liste des
    // points affichée vient du serveur, jamais d'un calcul navigateur.
    await refreshMeasurementVerdicts(client, executionId, execution.plan_version_id, execution.equipement_id);

    await client.query(
      `UPDATE public.metrologie_execution SET updated_at = now(), updated_by = $2 WHERE id = $1::uuid`,
      [executionId, actor.user_id]
    );

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: execution.equipement_id,
      entity_type: "EXECUTION",
      entity_id: executionId,
      event_type: "EXECUTION_MEASUREMENTS_RECORDED",
      actor,
      old_values: null,
      new_values: { points: body.measurements.length },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.execution.measurements",
      aggregateType: "EXECUTION",
      aggregateId: executionId,
      requestPayload: { executionId, ...body },
      resultPayload: { id: executionId, points: body.measurements.length },
      correlationId,
    });
  });

  const detail = await repoGetExecution(executionId);
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Exécution introuvable.");
  return detail;
}

async function refreshMeasurementVerdicts(
  client: PoolClient,
  executionId: string,
  planVersionId: string | null,
  equipementId: string
): Promise<void> {
  const plan = planVersionId ? await loadPlanContext(client, planVersionId, equipementId) : null;
  const measurements = await loadMeasurements(client, executionId);
  const computation = computeExecutionVerdict({
    operationType: "ETALONNAGE",
    measurements,
    criteria: {
      tolerance_min: plan?.tolerance_min ?? null,
      tolerance_max: plan?.tolerance_max ?? null,
      unite: plan?.unite ?? null,
      min_points: plan?.min_points ?? null,
    },
  });

  for (const point of computation.points) {
    await client.query(
      `
        UPDATE public.metrologie_execution_measurement
        SET verdict = $3, ecart = $4, updated_at = now()
        WHERE execution_id = $1::uuid AND point_key = $2 AND sample_no = $5
      `,
      [executionId, point.point_key, point.verdict, point.ecart, point.sample_no]
    );
  }
}

/* ========================================================================== */
/* Aperçu du verdict                                                          */
/* ========================================================================== */

export async function repoPreviewVerdict(
  executionId: string
): Promise<MetrologyVerdictPreviewDTO> {
  const execRes = await db().query<Record<string, unknown>>(
    `
      SELECT x.id::text AS id, x.equipement_id::text AS equipement_id, x.operation_type,
             x.plan_version_id::text AS plan_version_id, x.status,
             e.created_at::text AS equipement_created_at,
             e.date_mise_en_service::text AS date_mise_en_service
      FROM public.metrologie_execution x
      JOIN public.metrologie_equipements e ON e.id = x.equipement_id
      WHERE x.id = $1::uuid
    `,
    [executionId]
  );
  const execution = execRes.rows[0] ?? null;
  if (!execution) throw new HttpError(404, "NOT_FOUND", "Exécution introuvable.");

  const planVersionId = (execution.plan_version_id ?? null) as string | null;
  const plan = planVersionId
    ? await loadPlanContext(db(), planVersionId, String(execution.equipement_id))
    : null;
  const measurements = await loadMeasurements(db(), executionId);

  const computation = computeExecutionVerdict({
    operationType: execution.operation_type as MetrologyOperationType,
    measurements,
    criteria: {
      tolerance_min: plan?.tolerance_min ?? null,
      tolerance_max: plan?.tolerance_max ?? null,
      unite: plan?.unite ?? null,
      min_points: plan?.min_points ?? null,
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const schedule = plan
    ? computeNextDueDate({
        plan: {
          periodicite_valeur: plan.periodicite_valeur,
          periodicite_unite: plan.periodicite_unite,
          base_calcul: plan.base_calcul,
          alert_window_days: plan.alert_window_days,
          effective_from: plan.effective_from,
        },
        lastProofDate: verdictIsAdmissibleProof(computation.verdict) ? today : null,
        fallbackDate:
          (execution.date_mise_en_service as string | null) ??
          String(execution.equipement_created_at).slice(0, 10),
      })
    : { next_due_date: null, source: "NONE" as const, base_date: null };

  // Les effets réels sont annoncés AVANT confirmation : aucune surprise après
  // le clic, et aucune action implicite sur les autres modules.
  const effects: string[] = [];
  if (verdictIsAdmissibleProof(computation.verdict)) {
    effects.push("La preuve devient la dernière preuve conforme de l'instrument.");
    if (schedule.next_due_date) {
      effects.push(`La prochaine échéance est fixée au ${schedule.next_due_date}.`);
    }
    effects.push("L'instrument redevient sélectionnable pour les contrôles compatibles.");
  }
  if (verdictTriggersQuarantine(computation.verdict)) {
    effects.push("L'instrument passe en quarantaine : plus aucune nouvelle mesure ne l'acceptera.");
    effects.push(
      "Un dossier d'analyse d'impact est ouvert sur la période depuis la dernière preuve conforme."
    );
    effects.push(
      "Aucun contrôle n'est annulé, aucun lot n'est déstocké, aucun BL n'est annulé : chaque usage devra être décidé à la main."
    );
  }
  if (computation.verdict === "INCONCLU") {
    effects.push("Aucune preuve d'aptitude n'est produite : l'échéance en cours reste inchangée.");
  }
  if (computation.verdict === "CONFORME_AVEC_RESTRICTION") {
    effects.push("La restriction saisie sera affichée à chaque sélection de l'instrument.");
  }

  const preview = {
    execution_id: executionId,
    verdict_computed: computation.verdict,
    explanation: computation.explanation,
    counts: computation.counts,
    points: computation.points,
    next_due_date: schedule.next_due_date,
    next_due_source: schedule.source,
    effects,
  };

  return { ...preview, preview_hash: metrologySha256(preview) };
}

/* ========================================================================== */
/* Validation : la transaction « hors tolérance »                             */
/* ========================================================================== */

export async function repoValidateExecution(params: {
  executionId: string;
  body: ValidateExecutionBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<{ execution: MetrologyExecutionDTO; impact_dossier_id: string | null }> {
  const { executionId, body, actor } = params;

  const outcome = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.execution.validate",
      requestPayload: { executionId, ...body },
    });
    if (claim.replay) {
      return {
        impactDossierId: (claim.replay.impact_dossier_id ?? null) as string | null,
        replayed: true,
      };
    }

    // 1) Verrouiller équipement, plan et exécution ; vérifier version.
    const execution = await lockExecution(client, executionId);
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: execution.updated_at,
    });
    assertExecutionTransition(execution.status, "VALIDATED");

    const equipRes = await client.query<{
      id: string;
      etat: string;
      criticite: string;
      created_at: string;
      date_mise_en_service: string | null;
    }>(
      `SELECT id::text AS id, etat, criticite, created_at::text AS created_at,
              date_mise_en_service::text AS date_mise_en_service
         FROM public.metrologie_equipements WHERE id = $1::uuid FOR UPDATE`,
      [execution.equipement_id]
    );
    const equipment = equipRes.rows[0];
    if (!equipment) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");

    const plan = execution.plan_version_id
      ? await loadPlanContext(client, execution.plan_version_id, execution.equipement_id)
      : null;
    if (plan) {
      await client.query(`SELECT 1 FROM public.metrologie_plan_version WHERE id = $1::uuid FOR UPDATE`, [
        plan.id,
      ]);
    }

    // 2) Séparation des tâches et fraîcheur de l'aperçu.
    assertVerdictSeparation({
      operatorUserId: execution.operator_user_id,
      validatorUserId: actor.user_id,
      operationType: execution.operation_type,
    });

    const preview = await repoPreviewVerdictInTx(client, executionId);
    if (preview.preview_hash !== body.preview_hash) {
      throw new HttpError(
        409,
        "METROLOGY_PREVIEW_STALE",
        "L'aperçu n'est plus à jour : rechargez-le avant de confirmer le verdict."
      );
    }

    const evidenceRes = await client.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM public.metrologie_certificats
        WHERE execution_id = $1::uuid AND deleted_at IS NULL AND statut = 'VALIDE'`,
      [executionId]
    );
    const evidenceCount = toInt(evidenceRes.rows[0]?.total, 0);

    assertManualVerdictOverride({
      computed: preview.verdict_computed,
      requested: body.verdict,
      justification: body.verdict_justification,
      evidenceCount,
      requireEvidence: true,
    });

    if (plan?.exige_certificat && verdictIsAdmissibleProof(body.verdict) && evidenceCount === 0) {
      throw new HttpError(
        422,
        "METROLOGY_CERTIFICATE_REQUIRED",
        "Ce plan exige un certificat ou un PV valide avant de conclure à la conformité."
      );
    }

    // 3) Échéance : calculée serveur, dérogation possible mais approuvée.
    let nextDueDate = preview.next_due_date;
    if (body.override_next_due_date) {
      assertScheduleOverrideAllowed({
        requestedDueDate: body.override_next_due_date,
        computedDueDate: preview.next_due_date,
        reason: body.override_reason,
        approvedByUserId: body.override_approved_by,
        requestedByUserId: actor.user_id,
      });
      nextDueDate = body.override_next_due_date;
    }

    // 4) Figer l'exécution.
    await client.query(
      `
        UPDATE public.metrologie_execution
        SET status = 'VALIDATED',
            ended_at = COALESCE($2::timestamptz, now()),
            verdict_computed = $3,
            verdict = $4,
            verdict_justification = $5,
            restriction = $6,
            decision = $7,
            decision_reason = $8,
            decided_by = $9,
            decided_at = now(),
            next_due_date = $10::date,
            updated_at = now(),
            updated_by = $9
        WHERE id = $1::uuid
      `,
      [
        executionId,
        body.ended_at ?? null,
        preview.verdict_computed,
        body.verdict,
        body.verdict_justification,
        body.restriction,
        body.decision,
        body.decision_reason,
        actor.user_id,
        nextDueDate,
      ]
    );

    const correlationId = crypto.randomUUID();
    let impactDossierId: string | null = null;

    if (verdictIsAdmissibleProof(body.verdict)) {
      const proofDate = (body.ended_at ?? new Date().toISOString()).slice(0, 10);
      if (plan) {
        await client.query(
          `
            UPDATE public.metrologie_plan_version
            SET last_proof_execution_id = $2::uuid, last_proof_date = $3::date,
                next_due_date = $4::date, updated_at = now(), updated_by = $5
            WHERE id = $1::uuid
          `,
          [plan.id, executionId, proofDate, nextDueDate, actor.user_id]
        );
        await syncLegacyPlan(client, {
          equipementId: execution.equipement_id,
          actorId: actor.user_id,
          periodiciteMois: monthsFromPeriodicity(plan.periodicite_valeur, plan.periodicite_unite),
          lastDoneDate: proofDate,
          nextDueDate,
          statut: "EN_COURS",
        });
      }

      await client.query(
        `
          UPDATE public.metrologie_equipements
          SET last_conforme_execution_id = $2::uuid, last_conforme_at = COALESCE($3::timestamptz, now()),
              updated_at = now(), updated_by = $4
          WHERE id = $1::uuid
        `,
        [execution.equipement_id, executionId, body.ended_at ?? null, actor.user_id]
      );

      // Une preuve conforme ne libère PAS automatiquement un instrument en
      // quarantaine : la remise en service reste un acte humain habilité.
      if (body.decision === "REMISE_EN_SERVICE" && equipment.etat === "ACTIVE") {
        await client.query(
          `UPDATE public.metrologie_equipements
             SET etat = 'QUALIFIED', etat_motif = $2, etat_changed_at = now(), etat_changed_by = $3,
                 updated_at = now(), updated_by = $3
           WHERE id = $1::uuid`,
          [execution.equipement_id, body.decision_reason, actor.user_id]
        );
      }
    }

    // 5) Hors tolérance : quarantaine ciblée + analyse d'impact bornée.
    if (verdictTriggersQuarantine(body.verdict)) {
      await client.query(
        `
          UPDATE public.metrologie_equipements
          SET etat = 'OUT_OF_TOLERANCE',
              etat_motif = $2, etat_changed_at = now(), etat_changed_by = $3,
              quarantine_reason = $2, quarantined_at = now(), quarantined_by = $3,
              updated_at = now(), updated_by = $3
          WHERE id = $1::uuid
        `,
        [execution.equipement_id, body.decision_reason, actor.user_id]
      );

      if (plan) {
        await syncLegacyPlan(client, {
          equipementId: execution.equipement_id,
          actorId: actor.user_id,
          periodiciteMois: monthsFromPeriodicity(plan.periodicite_valeur, plan.periodicite_unite),
          lastDoneDate: null,
          nextDueDate: null,
          statut: "HORS_TOLERANCE",
        });
      }

      const dossier = await openImpactDossier(client, {
        equipementId: execution.equipement_id,
        executionId,
        certificatId: null,
        trigger: "VERDICT_NON_CONFORME",
        actor,
        correlationId,
        approvedWindow: null,
        exclusions: null,
        ownerUserId: null,
      });
      impactDossierId = dossier.id;
    }

    // 6) Journal, audit et reçu — même commit.
    await insertMetrologyEvent(client, {
      equipement_id: execution.equipement_id,
      entity_type: "EXECUTION",
      entity_id: executionId,
      event_type: "EXECUTION_VALIDATED",
      actor,
      old_values: { status: execution.status },
      new_values: {
        verdict_computed: preview.verdict_computed,
        verdict: body.verdict,
        decision: body.decision,
        next_due_date: nextDueDate,
        impact_dossier_id: impactDossierId,
      },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      rule_code: preview.verdict_computed === body.verdict ? "VERDICT_COMPUTED" : "VERDICT_OVERRIDDEN",
      reason: body.decision_reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.executions.validate",
      entity_type: "metrologie_execution",
      entity_id: executionId,
      details: {
        code: execution.code,
        verdict: body.verdict,
        verdict_computed: preview.verdict_computed,
        decision: body.decision,
        impact_dossier_id: impactDossierId,
      },
    });

    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.execution.validate",
      aggregateType: "EXECUTION",
      aggregateId: executionId,
      requestPayload: { executionId, ...body },
      resultPayload: { id: executionId, verdict: body.verdict, impact_dossier_id: impactDossierId },
      correlationId,
    });

    return { impactDossierId, replayed: false };
  });

  const detail = await repoGetExecution(executionId);
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Exécution introuvable.");
  return { execution: detail, impact_dossier_id: outcome.impactDossierId };
}

/** Version transactionnelle de l'aperçu, pour comparer l'empreinte sous verrou. */
async function repoPreviewVerdictInTx(
  client: PoolClient,
  executionId: string
): Promise<MetrologyVerdictPreviewDTO> {
  const execRes = await client.query<Record<string, unknown>>(
    `
      SELECT x.id::text AS id, x.equipement_id::text AS equipement_id, x.operation_type,
             x.plan_version_id::text AS plan_version_id,
             e.created_at::text AS equipement_created_at,
             e.date_mise_en_service::text AS date_mise_en_service
      FROM public.metrologie_execution x
      JOIN public.metrologie_equipements e ON e.id = x.equipement_id
      WHERE x.id = $1::uuid
    `,
    [executionId]
  );
  const execution = execRes.rows[0];
  if (!execution) throw new HttpError(404, "NOT_FOUND", "Exécution introuvable.");

  const planVersionId = (execution.plan_version_id ?? null) as string | null;
  const plan = planVersionId
    ? await loadPlanContext(client, planVersionId, String(execution.equipement_id))
    : null;
  const measurements = await loadMeasurements(client, executionId);

  const computation = computeExecutionVerdict({
    operationType: execution.operation_type as MetrologyOperationType,
    measurements,
    criteria: {
      tolerance_min: plan?.tolerance_min ?? null,
      tolerance_max: plan?.tolerance_max ?? null,
      unite: plan?.unite ?? null,
      min_points: plan?.min_points ?? null,
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  const schedule = plan
    ? computeNextDueDate({
        plan: {
          periodicite_valeur: plan.periodicite_valeur,
          periodicite_unite: plan.periodicite_unite,
          base_calcul: plan.base_calcul,
          alert_window_days: plan.alert_window_days,
          effective_from: plan.effective_from,
        },
        lastProofDate: verdictIsAdmissibleProof(computation.verdict) ? today : null,
        fallbackDate:
          (execution.date_mise_en_service as string | null) ??
          String(execution.equipement_created_at).slice(0, 10),
      })
    : { next_due_date: null, source: "NONE" as const, base_date: null };

  const effects: string[] = [];
  if (verdictIsAdmissibleProof(computation.verdict)) {
    effects.push("La preuve devient la dernière preuve conforme de l'instrument.");
    if (schedule.next_due_date) effects.push(`La prochaine échéance est fixée au ${schedule.next_due_date}.`);
    effects.push("L'instrument redevient sélectionnable pour les contrôles compatibles.");
  }
  if (verdictTriggersQuarantine(computation.verdict)) {
    effects.push("L'instrument passe en quarantaine : plus aucune nouvelle mesure ne l'acceptera.");
    effects.push(
      "Un dossier d'analyse d'impact est ouvert sur la période depuis la dernière preuve conforme."
    );
    effects.push(
      "Aucun contrôle n'est annulé, aucun lot n'est déstocké, aucun BL n'est annulé : chaque usage devra être décidé à la main."
    );
  }
  if (computation.verdict === "INCONCLU") {
    effects.push("Aucune preuve d'aptitude n'est produite : l'échéance en cours reste inchangée.");
  }
  if (computation.verdict === "CONFORME_AVEC_RESTRICTION") {
    effects.push("La restriction saisie sera affichée à chaque sélection de l'instrument.");
  }

  const preview = {
    execution_id: executionId,
    verdict_computed: computation.verdict,
    explanation: computation.explanation,
    counts: computation.counts,
    points: computation.points,
    next_due_date: schedule.next_due_date,
    next_due_source: schedule.source,
    effects,
  };
  return { ...preview, preview_hash: metrologySha256(preview) };
}

export async function repoCancelExecution(params: {
  executionId: string;
  body: CancelExecutionBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyExecutionDTO> {
  const { executionId, body, actor } = params;
  await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.execution.cancel",
      requestPayload: { executionId, ...body },
    });
    if (claim.replay) return;

    const execution = await lockExecution(client, executionId);
    assertOptimisticVersion({
      expectedUpdatedAt: body.expected_updated_at,
      currentUpdatedAt: execution.updated_at,
    });
    assertExecutionTransition(execution.status, "CANCELLED");

    await client.query(
      `
        UPDATE public.metrologie_execution
        SET status = 'CANCELLED', decision_reason = $2, updated_at = now(), updated_by = $3
        WHERE id = $1::uuid
      `,
      [executionId, body.reason, actor.user_id]
    );

    const correlationId = crypto.randomUUID();
    await insertMetrologyEvent(client, {
      equipement_id: execution.equipement_id,
      entity_type: "EXECUTION",
      entity_id: executionId,
      event_type: "EXECUTION_CANCELLED",
      actor,
      old_values: { status: execution.status },
      new_values: { status: "CANCELLED" },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.executions.cancel",
      entity_type: "metrologie_execution",
      entity_id: executionId,
      details: { reason: body.reason },
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.execution.cancel",
      aggregateType: "EXECUTION",
      aggregateId: executionId,
      requestPayload: { executionId, ...body },
      resultPayload: { id: executionId, status: "CANCELLED" },
      correlationId,
    });
  });

  const detail = await repoGetExecution(executionId);
  if (!detail) throw new HttpError(404, "NOT_FOUND", "Exécution introuvable.");
  return detail;
}

/* ========================================================================== */
/* Lecture des exécutions                                                     */
/* ========================================================================== */

const EXECUTION_SELECT = `
  SELECT
    x.id::text AS id, x.code, x.equipement_id::text AS equipement_id,
    x.plan_version_id::text AS plan_version_id, x.plan_version,
    x.operation_type, x.status, x.verdict, x.verdict_computed, x.verdict_justification,
    x.started_at::text AS started_at, x.ended_at::text AS ended_at,
    x.provider_label, x.methode, x.procedure_ref, x.etalon_reference,
    x.environnement, x.incertitude::text AS incertitude, x.observations,
    x.decision, x.decision_reason, x.decided_at::text AS decided_at,
    x.restriction, x.next_due_date::text AS next_due_date,
    x.created_at::text AS created_at, x.updated_at::text AS updated_at,
    ou.id AS operator_id, ou.username AS operator_username,
    ou.name AS operator_name, ou.surname AS operator_surname,
    du.id AS decided_by_id, du.username AS decided_by_username,
    du.name AS decided_by_name, du.surname AS decided_by_surname,
    (SELECT COUNT(*)::int FROM public.metrologie_certificats c
      WHERE c.execution_id = x.id AND c.deleted_at IS NULL) AS certificate_count
  FROM public.metrologie_execution x
  LEFT JOIN public.users ou ON ou.id = x.operator_user_id
  LEFT JOIN public.users du ON du.id = x.decided_by
`;

function mapExecutionListItem(row: Record<string, unknown>): MetrologyExecutionListItemDTO {
  return {
    id: String(row.id),
    code: String(row.code),
    equipement_id: String(row.equipement_id),
    operation_type: row.operation_type as MetrologyOperationType,
    status: row.status as MetrologyExecutionListItemDTO["status"],
    verdict: (row.verdict ?? null) as MetrologyVerdict | null,
    started_at: String(row.started_at),
    ended_at: (row.ended_at ?? null) as string | null,
    operator: mapUserRef({
      id: (row.operator_id ?? null) as number | null,
      username: (row.operator_username ?? null) as string | null,
      name: (row.operator_name ?? null) as string | null,
      surname: (row.operator_surname ?? null) as string | null,
    }),
    provider_label: (row.provider_label ?? null) as string | null,
    next_due_date: (row.next_due_date ?? null) as string | null,
    certificate_count: toInt(row.certificate_count, 0),
    updated_at: String(row.updated_at),
  };
}

export async function repoListExecutions(
  query: ListExecutionsQueryDTO
): Promise<Paginated<MetrologyExecutionListItemDTO>> {
  const values: unknown[] = [];
  const where: string[] = [];
  const push = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  if (query.equipement_id) where.push(`x.equipement_id = ${push(query.equipement_id)}::uuid`);
  if (query.operation_type) where.push(`x.operation_type = ${push(query.operation_type)}`);
  if (query.status) where.push(`x.status = ${push(query.status)}`);
  if (query.verdict) where.push(`x.verdict = ${push(query.verdict)}`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const countRes = await db().query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM public.metrologie_execution x ${whereSql}`,
    values
  );

  const offset = (query.page - 1) * query.pageSize;
  const res = await db().query(
    `${EXECUTION_SELECT} ${whereSql}
     ORDER BY x.${query.sortBy} ${sortDirection(query.sortDir)} NULLS LAST, x.id DESC
     LIMIT ${push(query.pageSize)} OFFSET ${push(offset)}`,
    values
  );

  return {
    items: res.rows.map(mapExecutionListItem),
    total: toInt(countRes.rows[0]?.total, 0),
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function repoGetExecution(id: string): Promise<MetrologyExecutionDTO | null> {
  const res = await db().query(`${EXECUTION_SELECT} WHERE x.id = $1::uuid LIMIT 1`, [id]);
  const row = res.rows[0] ?? null;
  if (!row) return null;

  const measurementsRes = await db().query(
    `
      SELECT id::text AS id, point_key, sample_no, label,
             nominal::text AS nominal, tolerance_min::text AS tolerance_min,
             tolerance_max::text AS tolerance_max, measured::text AS measured,
             unite, incertitude::text AS incertitude, ecart::text AS ecart,
             verdict, comment, revision
      FROM public.metrologie_execution_measurement
      WHERE execution_id = $1::uuid
      ORDER BY point_key, sample_no
    `,
    [id]
  );

  const certificatsRes = await db().query(
    `
      SELECT
        c.id::text AS id, c.equipement_id::text AS equipement_id, c.execution_id::text AS execution_id,
        c.document_kind, c.date_etalonnage::text AS date_etalonnage,
        c.date_echeance::text AS date_echeance, c.resultat, c.statut,
        c.emetteur, c.numero_externe, c.organisme, c.commentaire, c.confidentiality,
        c.cancel_reason, c.cancelled_at::text AS cancelled_at, c.replaced_by_id::text AS replaced_by_id,
        c.file_original_name, c.mime_type, c.size_bytes::text AS size_bytes, c.sha256,
        (c.storage_path IS NOT NULL) AS has_file, c.created_at::text AS created_at,
        cb.id AS created_by_id, cb.username AS created_by_username,
        cb.name AS created_by_name, cb.surname AS created_by_surname
      FROM public.metrologie_certificats c
      LEFT JOIN public.users cb ON cb.id = c.created_by
      WHERE c.execution_id = $1::uuid AND c.deleted_at IS NULL
      ORDER BY c.created_at DESC
    `,
    [id]
  );

  return {
    ...mapExecutionListItem(row),
    plan_version_id: (row.plan_version_id ?? null) as string | null,
    plan_version: row.plan_version === null ? null : toInt(row.plan_version, 0),
    methode: (row.methode ?? null) as string | null,
    procedure_ref: (row.procedure_ref ?? null) as string | null,
    etalon_reference: (row.etalon_reference ?? null) as string | null,
    environnement: isRecord(row.environnement) ? row.environnement : {},
    incertitude: toNumber(row.incertitude),
    verdict_computed: (row.verdict_computed ?? null) as MetrologyVerdict | null,
    verdict_justification: (row.verdict_justification ?? null) as string | null,
    observations: (row.observations ?? null) as string | null,
    decision: (row.decision ?? null) as string | null,
    decision_reason: (row.decision_reason ?? null) as string | null,
    decided_by: mapUserRef({
      id: (row.decided_by_id ?? null) as number | null,
      username: (row.decided_by_username ?? null) as string | null,
      name: (row.decided_by_name ?? null) as string | null,
      surname: (row.decided_by_surname ?? null) as string | null,
    }),
    decided_at: (row.decided_at ?? null) as string | null,
    restriction: (row.restriction ?? null) as string | null,
    created_at: String(row.created_at),
    measurements: measurementsRes.rows.map((m: Record<string, unknown>) => ({
      id: String(m.id),
      point_key: String(m.point_key),
      sample_no: toInt(m.sample_no, 1),
      label: (m.label ?? null) as string | null,
      nominal: toNumber(m.nominal),
      tolerance_min: toNumber(m.tolerance_min),
      tolerance_max: toNumber(m.tolerance_max),
      measured: toNumber(m.measured),
      unite: (m.unite ?? null) as string | null,
      incertitude: toNumber(m.incertitude),
      ecart: toNumber(m.ecart),
      verdict: (m.verdict ?? null) as "CONFORME" | "NON_CONFORME" | "INCONCLU" | null,
      comment: (m.comment ?? null) as string | null,
      revision: toInt(m.revision, 1),
    })),
    certificats: certificatsRes.rows.map(mapCertificate),
  };
}

function mapCertificate(row: Record<string, unknown>): MetrologyCertificateDTO {
  return {
    id: String(row.id),
    equipement_id: String(row.equipement_id),
    execution_id: (row.execution_id ?? null) as string | null,
    document_kind: row.document_kind as MetrologyCertificateDTO["document_kind"],
    date_etalonnage: String(row.date_etalonnage),
    date_echeance: (row.date_echeance ?? null) as string | null,
    resultat: row.resultat as MetrologyCertificateDTO["resultat"],
    statut: row.statut as MetrologyCertificateDTO["statut"],
    emetteur: (row.emetteur ?? null) as string | null,
    numero_externe: (row.numero_externe ?? null) as string | null,
    organisme: (row.organisme ?? null) as string | null,
    commentaire: (row.commentaire ?? null) as string | null,
    confidentiality: row.confidentiality as MetrologyCertificateDTO["confidentiality"],
    cancel_reason: (row.cancel_reason ?? null) as string | null,
    cancelled_at: (row.cancelled_at ?? null) as string | null,
    replaced_by_id: (row.replaced_by_id ?? null) as string | null,
    file_original_name: (row.file_original_name ?? null) as string | null,
    mime_type: (row.mime_type ?? null) as string | null,
    size_bytes: toNumber(row.size_bytes),
    sha256: (row.sha256 ?? null) as string | null,
    has_file: row.has_file === true,
    created_at: String(row.created_at),
    created_by: mapUserRef({
      id: (row.created_by_id ?? null) as number | null,
      username: (row.created_by_username ?? null) as string | null,
      name: (row.created_by_name ?? null) as string | null,
      surname: (row.created_by_surname ?? null) as string | null,
    }),
  };
}

/* ========================================================================== */
/* Certificats et PV                                                          */
/* ========================================================================== */

const ALLOWED_DOCUMENT_TYPES: ReadonlyArray<{
  extension: string;
  mime: readonly string[];
  signature: readonly number[] | null;
}> = [
  { extension: ".pdf", mime: ["application/pdf"], signature: [0x25, 0x50, 0x44, 0x46] },
  { extension: ".png", mime: ["image/png"], signature: [0x89, 0x50, 0x4e, 0x47] },
  { extension: ".jpg", mime: ["image/jpeg"], signature: [0xff, 0xd8, 0xff] },
  { extension: ".jpeg", mime: ["image/jpeg"], signature: [0xff, 0xd8, 0xff] },
  { extension: ".tif", mime: ["image/tiff"], signature: null },
  { extension: ".tiff", mime: ["image/tiff"], signature: null },
];

const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

/**
 * Contrôle extension + MIME + signature + taille. Un fichier renommé `.pdf`
 * mais dont les premiers octets ne sont pas ceux d'un PDF est refusé : le nom
 * de fichier n'est pas une preuve de format.
 */
async function assertDocumentSafe(file: Express.Multer.File): Promise<void> {
  if (file.size <= 0) {
    throw new HttpError(422, "METROLOGY_DOCUMENT_EMPTY", "Le document est vide.");
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    throw new HttpError(413, "METROLOGY_DOCUMENT_TOO_LARGE", "Le document dépasse 25 Mo.");
  }

  const extension = path.extname(file.originalname).toLowerCase();
  const allowed = ALLOWED_DOCUMENT_TYPES.find((entry) => entry.extension === extension);
  if (!allowed) {
    throw new HttpError(
      422,
      "METROLOGY_DOCUMENT_EXTENSION_REJECTED",
      "Format non accepté : PDF, PNG, JPEG ou TIFF uniquement."
    );
  }
  if (!allowed.mime.includes(file.mimetype)) {
    throw new HttpError(
      422,
      "METROLOGY_DOCUMENT_MIME_REJECTED",
      `Type MIME incohérent avec l'extension ${extension}.`
    );
  }
  if (allowed.signature) {
    const handle = await fs.open(file.path, "r");
    try {
      const buffer = Buffer.alloc(allowed.signature.length);
      await handle.read(buffer, 0, allowed.signature.length, 0);
      const matches = allowed.signature.every((byte, index) => buffer[index] === byte);
      if (!matches) {
        throw new HttpError(
          422,
          "METROLOGY_DOCUMENT_SIGNATURE_REJECTED",
          "Le contenu du fichier ne correspond pas à son extension."
        );
      }
    } finally {
      await handle.close();
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

export function metrologyDocsBaseDir(): string {
  return ensureDocumentStoragePath("metrologie");
}

export async function repoUploadCertificate(params: {
  equipementId: string;
  body: UploadCertificateBodyDTO;
  file: Express.Multer.File | null;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<MetrologyCertificateDTO> {
  const { equipementId, body, file, actor } = params;
  if (!file) {
    throw new HttpError(422, "METROLOGY_DOCUMENT_REQUIRED", "Le fichier du certificat est obligatoire.");
  }
  await assertDocumentSafe(file);

  const docsDirRel = ensureDocumentStoragePath("metrologie");
  const docsDirAbs = path.resolve(docsDirRel);
  await fs.mkdir(docsDirAbs, { recursive: true });

  const certId = crypto.randomUUID();
  const extension = path.extname(file.originalname).toLowerCase();
  const storedName = `${certId}${extension}`;
  const relPath = path.join(docsDirRel, storedName).split(path.sep).join(path.posix.sep);
  const absPath = path.join(docsDirAbs, storedName);

  try {
    await fs.rename(path.resolve(file.path), absPath);
  } catch {
    await fs.copyFile(path.resolve(file.path), absPath);
    await fs.unlink(path.resolve(file.path));
  }
  registerUploadDestination(file, absPath);
  const hash = await sha256File(absPath);

  try {
    await withTransaction(async (client) => {
      const claim = await acquireIdempotency({
        client,
        actor,
        idempotencyKeyRaw: params.idempotencyKey,
        commandType: "metrology.certificate.upload",
        requestPayload: { equipementId, ...body, sha256: hash },
      });
      if (claim.replay) return;

      const equip = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.metrologie_equipements
          WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE`,
        [equipementId]
      );
      if (!equip.rows[0]) throw new HttpError(404, "NOT_FOUND", "Équipement introuvable.");

      if (body.execution_id) {
        const exec = await client.query<{ id: string }>(
          `SELECT id::text AS id FROM public.metrologie_execution
            WHERE id = $1::uuid AND equipement_id = $2::uuid`,
          [body.execution_id, equipementId]
        );
        if (!exec.rows[0]) {
          throw new HttpError(422, "METROLOGY_EXECUTION_MISMATCH", "Cette exécution n'appartient pas à l'équipement.");
        }
      }

      try {
        await client.query(
          `
            INSERT INTO public.metrologie_certificats (
              id, equipement_id, execution_id, document_kind,
              date_etalonnage, date_echeance, resultat, statut,
              emetteur, numero_externe, organisme, commentaire, confidentiality,
              file_original_name, storage_path, mime_type, size_bytes, sha256,
              created_by, updated_by
            )
            VALUES (
              $1::uuid,$2::uuid,$3::uuid,$4,
              $5::date,$6::date,$7,'VALIDE',
              $8,$9,$10,$11,$12,
              $13,$14,$15,$16,$17,
              $18,$18
            )
          `,
          [
            certId,
            equipementId,
            body.execution_id ?? null,
            body.document_kind,
            body.date_etalonnage,
            body.date_echeance ?? null,
            body.resultat,
            body.emetteur ?? null,
            body.numero_externe ?? null,
            body.organisme ?? null,
            body.commentaire ?? null,
            body.confidentiality,
            file.originalname,
            relPath,
            file.mimetype,
            file.size,
            hash,
            actor.user_id,
          ]
        );
      } catch (err) {
        rethrowMapped(err);
      }

      const correlationId = crypto.randomUUID();
      await insertMetrologyEvent(client, {
        equipement_id: equipementId,
        entity_type: "CERTIFICAT",
        entity_id: certId,
        event_type: "CERTIFICAT_ATTACHED",
        actor,
        old_values: null,
        // Le journal porte l'empreinte, jamais le chemin de stockage.
        new_values: {
          document_kind: body.document_kind,
          resultat: body.resultat,
          emetteur: body.emetteur ?? null,
          sha256: hash,
        },
        correlation_id: correlationId,
        idempotency_key: claim.idempotencyKey,
      });
      await insertAuditLog(client, actor, {
        action: "metrologie.certificats.upload",
        entity_type: "metrologie_certificats",
        entity_id: certId,
        details: { equipement_id: equipementId, document_kind: body.document_kind, sha256: hash },
      });
      await saveReceipt({
        client,
        actor,
        claim,
        commandType: "metrology.certificate.upload",
        aggregateType: "CERTIFICAT",
        aggregateId: certId,
        requestPayload: { equipementId, ...body, sha256: hash },
        resultPayload: { id: certId, sha256: hash },
        correlationId,
      });
    });
  } catch (err) {
    // Le fichier ne doit pas survivre à une transaction annulée : sinon on
    // accumule des preuves orphelines dans le stockage privé.
    await fs.unlink(absPath).catch(() => undefined);
    throw err;
  }

  const res = await db().query(
    `
      SELECT
        c.id::text AS id, c.equipement_id::text AS equipement_id, c.execution_id::text AS execution_id,
        c.document_kind, c.date_etalonnage::text AS date_etalonnage,
        c.date_echeance::text AS date_echeance, c.resultat, c.statut,
        c.emetteur, c.numero_externe, c.organisme, c.commentaire, c.confidentiality,
        c.cancel_reason, c.cancelled_at::text AS cancelled_at, c.replaced_by_id::text AS replaced_by_id,
        c.file_original_name, c.mime_type, c.size_bytes::text AS size_bytes, c.sha256,
        (c.storage_path IS NOT NULL) AS has_file, c.created_at::text AS created_at,
        cb.id AS created_by_id, cb.username AS created_by_username,
        cb.name AS created_by_name, cb.surname AS created_by_surname
      FROM public.metrologie_certificats c
      LEFT JOIN public.users cb ON cb.id = c.created_by
      WHERE c.id = $1::uuid
    `,
    [certId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(500, "METROLOGY_CERTIFICATE_RELOAD_FAILED", "Certificat introuvable après dépôt.");
  return mapCertificate(row);
}

export async function repoCancelCertificate(params: {
  equipementId: string;
  certificateId: string;
  body: CancelCertificateBodyDTO;
  actor: MetrologyActor;
  idempotencyKey: string | null;
}): Promise<{ certificate: MetrologyCertificateDTO; impact_dossier_id: string | null }> {
  const { equipementId, certificateId, body, actor } = params;
  const impactDossierId = await withTransaction(async (client) => {
    const claim = await acquireIdempotency({
      client,
      actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "metrology.certificate.cancel",
      requestPayload: { equipementId, certificateId, ...body },
    });
    if (claim.replay) return (claim.replay.impact_dossier_id ?? null) as string | null;

    const res = await client.query<{ id: string; statut: string }>(
      `SELECT id::text AS id, statut FROM public.metrologie_certificats
        WHERE id = $1::uuid AND equipement_id = $2::uuid AND deleted_at IS NULL FOR UPDATE`,
      [certificateId, equipementId]
    );
    const current = res.rows[0] ?? null;
    if (!current) throw new HttpError(404, "NOT_FOUND", "Certificat introuvable.");
    if (current.statut !== "VALIDE") {
      throw new HttpError(
        409,
        "METROLOGY_CERTIFICATE_NOT_VALID",
        "Ce certificat n'est plus valide : son statut ne se réécrit pas."
      );
    }

    await client.query(
      `
        UPDATE public.metrologie_certificats
        SET statut = CASE WHEN $3::uuid IS NULL THEN 'ANNULE' ELSE 'REMPLACE' END,
            cancel_reason = $2, cancelled_at = now(), cancelled_by = $4,
            replaced_by_id = $3::uuid, updated_at = now(), updated_by = $4
        WHERE id = $1::uuid
      `,
      [certificateId, body.reason, body.replaced_by_id ?? null, actor.user_id]
    );

    const correlationId = crypto.randomUUID();
    let dossierId: string | null = null;
    if (body.open_impact_analysis) {
      const dossier = await openImpactDossier(client, {
        equipementId,
        executionId: null,
        certificatId: certificateId,
        trigger: "CERTIFICAT_INVALIDE",
        actor,
        correlationId,
        approvedWindow: null,
        exclusions: null,
        ownerUserId: null,
      });
      dossierId = dossier.id;
    }

    await insertMetrologyEvent(client, {
      equipement_id: equipementId,
      entity_type: "CERTIFICAT",
      entity_id: certificateId,
      event_type: body.replaced_by_id ? "CERTIFICAT_REPLACED" : "CERTIFICAT_CANCELLED",
      actor,
      old_values: { statut: current.statut },
      new_values: {
        statut: body.replaced_by_id ? "REMPLACE" : "ANNULE",
        impact_dossier_id: dossierId,
      },
      correlation_id: correlationId,
      idempotency_key: claim.idempotencyKey,
      reason: body.reason,
    });
    await insertAuditLog(client, actor, {
      action: "metrologie.certificats.cancel",
      entity_type: "metrologie_certificats",
      entity_id: certificateId,
      details: { reason: body.reason, impact_dossier_id: dossierId },
    });
    await saveReceipt({
      client,
      actor,
      claim,
      commandType: "metrology.certificate.cancel",
      aggregateType: "CERTIFICAT",
      aggregateId: certificateId,
      requestPayload: { equipementId, certificateId, ...body },
      resultPayload: { id: certificateId, impact_dossier_id: dossierId },
      correlationId,
    });
    return dossierId;
  });

  const res = await db().query(
    `
      SELECT
        c.id::text AS id, c.equipement_id::text AS equipement_id, c.execution_id::text AS execution_id,
        c.document_kind, c.date_etalonnage::text AS date_etalonnage,
        c.date_echeance::text AS date_echeance, c.resultat, c.statut,
        c.emetteur, c.numero_externe, c.organisme, c.commentaire, c.confidentiality,
        c.cancel_reason, c.cancelled_at::text AS cancelled_at, c.replaced_by_id::text AS replaced_by_id,
        c.file_original_name, c.mime_type, c.size_bytes::text AS size_bytes, c.sha256,
        (c.storage_path IS NOT NULL) AS has_file, c.created_at::text AS created_at,
        cb.id AS created_by_id, cb.username AS created_by_username,
        cb.name AS created_by_name, cb.surname AS created_by_surname
      FROM public.metrologie_certificats c
      LEFT JOIN public.users cb ON cb.id = c.created_by
      WHERE c.id = $1::uuid
    `,
    [certificateId]
  );
  const row = res.rows[0];
  if (!row) throw new HttpError(404, "NOT_FOUND", "Certificat introuvable.");
  return { certificate: mapCertificate(row), impact_dossier_id: impactDossierId };
}

/**
 * Lecture d'un document : le chemin de stockage ne sort JAMAIS de cette
 * fonction. Le contrôleur reçoit un chemin résolu, vérifié comme interne au
 * répertoire privé, et ne le renvoie pas au client.
 */
export async function repoGetCertificateFile(params: {
  equipementId: string;
  certificateId: string;
  actor: MetrologyActor;
}): Promise<{ storage_path: string; mime_type: string | null; file_original_name: string | null }> {
  return withTransaction(async (client) => {
    const res = await client.query<{
      storage_path: string | null;
      mime_type: string | null;
      file_original_name: string | null;
    }>(
      `
        SELECT storage_path, mime_type, file_original_name
        FROM public.metrologie_certificats
        WHERE id = $1::uuid AND equipement_id = $2::uuid AND deleted_at IS NULL
        LIMIT 1
      `,
      [params.certificateId, params.equipementId]
    );
    const row = res.rows[0] ?? null;
    if (!row || !row.storage_path) throw new HttpError(404, "NOT_FOUND", "Document introuvable.");

    // Chaque accès à une preuve est journalisé : « qui a lu quoi, quand ».
    await insertAuditLog(client, params.actor, {
      action: "metrologie.certificats.download",
      entity_type: "metrologie_certificats",
      entity_id: params.certificateId,
      details: { equipement_id: params.equipementId },
    });

    return {
      storage_path: row.storage_path,
      mime_type: row.mime_type,
      file_original_name: row.file_original_name,
    };
  });
}
