import type { PoolClient } from "pg";

import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import {
  affectedModulesFor,
  assertReferenceEffectiveDateAllowed,
  assertReferenceSnapshotFresh,
  changedFields,
  referencePayloadHash,
  REFERENCE_DATASETS,
} from "../domain/reference-data-policy";
import type {
  ReferenceChange,
  ReferenceChangeInput,
  ReferenceChangeSetDTO,
  ReferenceComparisonItem,
  ReferenceDataAuditContext,
  ReferenceDatasetCode,
  ReferenceDatasetSummaryDTO,
  ReferencePreviewDTO,
  ReferenceRecordDTO,
  WritableReferenceDatasetCode,
} from "../types/reference-data.types";
import type {
  CreateReferenceChangeSetInput,
  ReferenceDecisionInput,
  ReferencePreviewInput,
} from "../validators/reference-data.validators";

type Queryer = Pick<PoolClient, "query">;

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function statusFor(from: string | null, to: string | null): ReferenceRecordDTO["status"] {
  if (!from) return "MISSING";
  const at = today();
  if (from > at) return "FUTURE";
  if (to && to < at) return "EXPIRED";
  return "ACTIVE";
}

async function ensureInstalled(queryer: Queryer): Promise<void> {
  const result = await queryer.query<{ installed: boolean }>(
    `SELECT to_regclass('public.reference_data_change_sets') IS NOT NULL
         AND to_regclass('public.reference_data_versions') IS NOT NULL
         AND to_regclass('public.reference_data_decisions') IS NOT NULL AS installed`
  );
  if (!result.rows[0]?.installed) {
    throw new HttpError(503, "REFERENCE_DATA_CENTER_NOT_INSTALLED", "Le patch SOL-33 du centre de référence n'est pas appliqué.");
  }
}

async function relationExists(queryer: Queryer, relation: string): Promise<boolean> {
  const result = await queryer.query<{ present: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS present`, [relation]);
  return Boolean(result.rows[0]?.present);
}

async function insertAudit(
  tx: Queryer,
  audit: ReferenceDataAuditContext,
  action: string,
  entityId: string,
  details: Record<string, unknown>
): Promise<void> {
  await repoInsertAuditLog({
    user_id: audit.user_id,
    body: {
      event_type: "ACTION",
      action,
      page_key: audit.page_key ?? "reference-data",
      entity_type: "reference_data_change_set",
      entity_id: entityId,
      path: audit.path,
      client_session_id: audit.client_session_id,
      details,
    },
    ip: audit.ip,
    user_agent: audit.user_agent,
    device_type: audit.device_type,
    os: audit.os,
    browser: audit.browser,
    tx,
  });
}

const CHANGE_SET_SELECT = `
  id::text AS id, status, effective_from::text AS effective_from, effective_to::text AS effective_to,
  reason, source, reliability, changes, comparison, affected_modules, expected_snapshot_sha256,
  idempotency_key,
  proposed_by, approved_by, approved_at::text AS approved_at,
  rejected_by, rejected_at::text AS rejected_at, rejection_reason,
  applied_by, applied_at::text AS applied_at, failure_code,
  created_at::text AS created_at, updated_at::text AS updated_at
`;

function mapChangeSet(row: Record<string, unknown>): ReferenceChangeSetDTO {
  return {
    id: String(row.id),
    status: row.status as ReferenceChangeSetDTO["status"],
    effective_from: String(row.effective_from),
    effective_to: textOrNull(row.effective_to),
    reason: String(row.reason),
    source: String(row.source),
    reliability: row.reliability as ReferenceChangeSetDTO["reliability"],
    changes: row.changes as ReferenceChange[],
    comparison: row.comparison as ReferenceComparisonItem[],
    affected_modules: Array.isArray(row.affected_modules) ? row.affected_modules.map(String) : [],
    expected_snapshot_sha256: String(row.expected_snapshot_sha256),
    proposed_by: Number(row.proposed_by),
    approved_by: row.approved_by == null ? null : Number(row.approved_by),
    approved_at: textOrNull(row.approved_at),
    rejected_by: row.rejected_by == null ? null : Number(row.rejected_by),
    rejected_at: textOrNull(row.rejected_at),
    rejection_reason: textOrNull(row.rejection_reason),
    applied_by: row.applied_by == null ? null : Number(row.applied_by),
    applied_at: textOrNull(row.applied_at),
    failure_code: textOrNull(row.failure_code),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

async function latestGovernanceVersion(queryer: Queryer, datasetCode: string, recordKey: string): Promise<number | null> {
  const result = await queryer.query<{ version: number }>(
    `SELECT version FROM public.reference_data_versions
      WHERE dataset_code=$1 AND record_key=$2 ORDER BY version DESC LIMIT 1`,
    [datasetCode, recordKey]
  );
  return result.rows[0]?.version ?? null;
}

async function snapshotChange(queryer: Queryer, change: ReferenceChange): Promise<Record<string, unknown> | null> {
  switch (change.dataset_code) {
    case "HOURLY_RATES": {
      const result = await queryer.query(
        `SELECT cf.id::text AS record_key, cf.code, rate.taux_horaire::float8 AS amount, rate.devise AS currency
           FROM public.centres_frais cf
           LEFT JOIN LATERAL (
             SELECT taux_horaire, devise FROM public.production_cost_center_rates
              WHERE cf_id=cf.id AND date_effet <= CURRENT_DATE
                AND (date_fin IS NULL OR date_fin >= CURRENT_DATE)
              ORDER BY date_effet DESC LIMIT 1
           ) rate ON true
          WHERE cf.id=$1::uuid`,
        [change.record_key]
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "COST_CENTER_NOT_FOUND", "Centre de frais introuvable.");
      return { amount: numberOrNull(row.amount), currency: textOrNull(row.currency) };
    }
    case "PRODUCTION_CALENDARS": {
      const result = await queryer.query(
        `SELECT id::text, code, label, timezone, working_days,
                to_char(day_start,'HH24:MI') AS day_start, to_char(day_end,'HH24:MI') AS day_end, active
           FROM public.programmation_calendars
          WHERE id::text=$1 OR code=$1`,
        [change.record_key]
      );
      const row = result.rows[0];
      return row ? {
        code: String(row.code), label: String(row.label), timezone: String(row.timezone),
        working_days: Array.isArray(row.working_days) ? row.working_days.map(Number).sort() : [],
        day_start: String(row.day_start), day_end: String(row.day_end), active: Boolean(row.active),
      } : null;
    }
    case "MATERIAL_COSTS": {
      const result = await queryer.query(
        `SELECT prix_unitaire::float8 AS unit_price, COALESCE(devise,'EUR') AS currency
           FROM public.fournisseur_catalogue WHERE id=$1::uuid`, [change.record_key]
      );
      if (!result.rows[0]) throw new HttpError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "Ligne de catalogue fournisseur introuvable.");
      return { unit_price: numberOrNull(result.rows[0].unit_price), currency: String(result.rows[0].currency) };
    }
    case "UNIT_CONVERSIONS": {
      const result = await queryer.query(
        `SELECT unite AS purchase_unit, unite_stock AS stock_unit, coef_conversion::float8 AS factor
           FROM public.fournisseur_catalogue WHERE id=$1::uuid`, [change.record_key]
      );
      if (!result.rows[0]) throw new HttpError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "Ligne de catalogue fournisseur introuvable.");
      return {
        purchase_unit: textOrNull(result.rows[0].purchase_unit),
        stock_unit: textOrNull(result.rows[0].stock_unit),
        factor: numberOrNull(result.rows[0].factor),
      };
    }
    case "SUPPLIER_LEAD_TIMES": {
      const result = await queryer.query(
        `SELECT delai_jours AS lead_time_days FROM public.fournisseur_catalogue WHERE id=$1::uuid`, [change.record_key]
      );
      if (!result.rows[0]) throw new HttpError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "Ligne de catalogue fournisseur introuvable.");
      return { lead_time_days: numberOrNull(result.rows[0].lead_time_days) };
    }
    case "STOCK_VALUATION": {
      const result = await queryer.query(
        `SELECT COALESCE(value_text, value_json->>'method') AS method
           FROM public.erp_settings WHERE key='stock.valuation_method'`
      );
      return result.rows[0] ? { method: textOrNull(result.rows[0].method) } : null;
    }
  }
}

function afterFor(change: ReferenceChange): Record<string, unknown> {
  if (change.dataset_code === "PRODUCTION_CALENDARS") {
    return { ...change.value, working_days: [...change.value.working_days].sort() };
  }
  return { ...change.value };
}

async function buildComparison(queryer: Queryer, changes: ReferenceChange[]): Promise<ReferenceComparisonItem[]> {
  const comparisons: ReferenceComparisonItem[] = [];
  for (const change of changes) {
    const before = await snapshotChange(queryer, change);
    const after = afterFor(change);
    const fields = changedFields(before, after);
    const warnings: string[] = [];
    if (fields.length === 0) warnings.push("AUCUNE_DIFFERENCE");
    if (change.dataset_code === "STOCK_VALUATION") warnings.push("IMPACT_VALORISATION_ET_MARGES_FUTURES");
    if (change.dataset_code === "UNIT_CONVERSIONS") warnings.push("IMPACT_QUANTITES_ACHAT_ET_STOCK");
    comparisons.push({
      dataset_code: change.dataset_code,
      record_key: change.record_key,
      before,
      after,
      changed_fields: fields,
      affected_modules: affectedModulesFor(change.dataset_code),
      warnings,
    });
  }
  return comparisons;
}

async function validateReferenceDependencies(
  queryer: Queryer,
  input: Pick<ReferenceChangeInput, "effective_from" | "changes">
): Promise<void> {
  for (const change of input.changes) {
    if (change.dataset_code === "UNIT_CONVERSIONS") {
      const requested = [change.value.purchase_unit, change.value.stock_unit].map((unit) => unit.toLowerCase());
      const units = await queryer.query<{ code: string }>(
        `SELECT lower(code::text) AS code FROM public.units WHERE lower(code::text)=ANY($1::text[])`,
        [requested]
      );
      const available = new Set(units.rows.map((row) => row.code));
      if (requested.some((unit) => !available.has(unit))) {
        throw new HttpError(
          422,
          "UNKNOWN_CANONICAL_UNIT",
          "Les unités d'achat et de stock doivent exister dans le référentiel canonique avant la proposition."
        );
      }
    }

    if (change.dataset_code === "PRODUCTION_CALENDARS") {
      const duplicate = await queryer.query(
        `SELECT 1 FROM public.programmation_calendars
          WHERE code=$1 AND id::text<>$2 AND code<>$2 LIMIT 1`,
        [change.value.code, change.record_key]
      );
      if (duplicate.rows[0]) {
        throw new HttpError(409, "PRODUCTION_CALENDAR_CODE_CONFLICT", "Ce code calendrier est déjà utilisé.");
      }
    }

    if (change.dataset_code === "HOURLY_RATES") {
      const latest = await queryer.query<{ date_effet: string }>(
        `SELECT date_effet::text FROM public.production_cost_center_rates
          WHERE cf_id=$1::uuid ORDER BY date_effet DESC LIMIT 1`,
        [change.record_key]
      );
      if (latest.rows[0] && latest.rows[0].date_effet >= input.effective_from) {
        throw new HttpError(
          409,
          "NON_MONOTONIC_HOURLY_RATE",
          "Le nouveau taux doit prendre effet après la dernière version existante."
        );
      }
    }
  }
}

export async function repoPreviewReferenceChanges(input: ReferencePreviewInput): Promise<ReferencePreviewDTO> {
  assertReferenceEffectiveDateAllowed(input.effective_from, today());
  await validateReferenceDependencies(db, input);
  const comparison = await buildComparison(db, input.changes);
  const affected = [...new Set(comparison.flatMap((item) => item.affected_modules))].sort();
  return {
    effective_from: input.effective_from,
    effective_to: input.effective_to ?? null,
    comparison,
    affected_modules: affected,
    snapshot_sha256: referencePayloadHash(comparison.map(({ dataset_code, record_key, before }) => ({ dataset_code, record_key, before }))),
    request_sha256: referencePayloadHash(input),
    requires_approval: true,
    can_apply_now: input.effective_from <= today() && (input.effective_to == null || input.effective_to >= today()),
  };
}

export async function repoCreateReferenceChangeSet(
  input: CreateReferenceChangeSetInput,
  audit: ReferenceDataAuditContext
): Promise<{ change_set: ReferenceChangeSetDTO; replayed: boolean }> {
  const preview = await repoPreviewReferenceChanges(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await ensureInstalled(client);
    const replay = await client.query(
      `SELECT ${CHANGE_SET_SELECT}, request_sha256 FROM public.reference_data_change_sets
        WHERE proposed_by=$1 AND idempotency_key=$2 FOR UPDATE`, [audit.user_id, input.idempotency_key]
    );
    if (replay.rows[0]) {
      if (String(replay.rows[0].request_sha256) !== preview.request_sha256) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà été utilisée avec un autre contenu.");
      }
      await client.query("COMMIT");
      return { change_set: mapChangeSet(replay.rows[0]), replayed: true };
    }
    const inserted = await client.query(
      `INSERT INTO public.reference_data_change_sets
        (status,effective_from,effective_to,reason,source,reliability,changes,comparison,affected_modules,
         expected_snapshot_sha256,request_sha256,idempotency_key,proposed_by)
       VALUES ('PENDING_APPROVAL',$1::date,$2::date,$3,$4,$5,$6::jsonb,$7::jsonb,$8::text[],$9,$10,$11,$12)
       RETURNING ${CHANGE_SET_SELECT}`,
      [input.effective_from, input.effective_to ?? null, input.reason, input.source, input.reliability,
        JSON.stringify(input.changes), JSON.stringify(preview.comparison), preview.affected_modules,
        preview.snapshot_sha256, preview.request_sha256, input.idempotency_key, audit.user_id]
    );
    const row = inserted.rows[0];
    await client.query(
      `INSERT INTO public.reference_data_decisions
        (change_set_id,decision,reason,actor_user_id,idempotency_key,request_sha256)
       VALUES ($1::uuid,'PROPOSED',$2,$3,$4,$5)`,
      [row.id, input.reason, audit.user_id, input.idempotency_key, preview.request_sha256]
    );
    await insertAudit(client, audit, "reference_data.change_set.propose", String(row.id), {
      datasets: input.changes.map((change) => change.dataset_code),
      affected_modules: preview.affected_modules,
      effective_from: input.effective_from,
    });
    await client.query("COMMIT");
    return { change_set: mapChangeSet(row), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListReferenceChangeSets(params: { status?: string; limit: number }): Promise<ReferenceChangeSetDTO[]> {
  await ensureInstalled(db);
  const result = await db.query(
    `SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets
      WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC LIMIT $2`,
    [params.status ?? null, params.limit]
  );
  return result.rows.map(mapChangeSet);
}

export async function repoGetReferenceChangeSet(changeSetId: string): Promise<ReferenceChangeSetDTO | null> {
  await ensureInstalled(db);
  const result = await db.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid`, [changeSetId]);
  return result.rows[0] ? mapChangeSet(result.rows[0]) : null;
}

export async function repoDecideReferenceChangeSet(
  changeSetId: string,
  input: ReferenceDecisionInput,
  audit: ReferenceDataAuditContext
): Promise<{ change_set: ReferenceChangeSetDTO; replayed: boolean }> {
  const client = await db.connect();
  const decision = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
  const requestHash = referencePayloadHash({ changeSetId, ...input });
  try {
    await client.query("BEGIN");
    await ensureInstalled(client);
    const receipt = await client.query<{ request_sha256: string }>(
      `SELECT request_sha256 FROM public.reference_data_decisions
        WHERE actor_user_id=$1 AND decision=$2 AND idempotency_key=$3`,
      [audit.user_id, decision, input.idempotency_key]
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_sha256 !== requestHash) {
        throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé de décision a déjà été utilisée avec un autre contenu.");
      }
      const replay = await client.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid`, [changeSetId]);
      if (!replay.rows[0]) throw new HttpError(404, "REFERENCE_CHANGE_SET_NOT_FOUND", "Proposition introuvable.");
      await client.query("COMMIT");
      return { change_set: mapChangeSet(replay.rows[0]), replayed: true };
    }
    const locked = await client.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid FOR UPDATE`, [changeSetId]);
    const row = locked.rows[0];
    if (!row) throw new HttpError(404, "REFERENCE_CHANGE_SET_NOT_FOUND", "Proposition introuvable.");
    if (row.status !== "PENDING_APPROVAL") throw new HttpError(409, "REFERENCE_CHANGE_SET_NOT_PENDING", "Cette proposition a déjà reçu une décision.");
    if (Number(row.proposed_by) === audit.user_id) {
      throw new HttpError(403, "FOUR_EYES_APPROVAL_REQUIRED", "Le proposant ne peut pas approuver sa propre modification sensible.");
    }
    if (decision === "APPROVED") {
      await client.query(
        `UPDATE public.reference_data_change_sets
            SET status='APPROVED', approved_by=$2, approved_at=now(), updated_at=now()
          WHERE id=$1::uuid`, [changeSetId, audit.user_id]
      );
    } else {
      await client.query(
        `UPDATE public.reference_data_change_sets
            SET status='REJECTED', rejected_by=$2, rejected_at=now(), rejection_reason=$3, updated_at=now()
          WHERE id=$1::uuid`, [changeSetId, audit.user_id, input.reason]
      );
    }
    await client.query(
      `INSERT INTO public.reference_data_decisions
        (change_set_id,decision,reason,actor_user_id,idempotency_key,request_sha256)
       VALUES ($1::uuid,$2,$3,$4,$5,$6)`,
      [changeSetId, decision, input.reason, audit.user_id, input.idempotency_key, requestHash]
    );
    await insertAudit(client, audit, `reference_data.change_set.${decision.toLowerCase()}`, changeSetId, { reason: input.reason });
    const updated = await client.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid`, [changeSetId]);
    await client.query("COMMIT");
    return { change_set: mapChangeSet(updated.rows[0]), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function recordSupplierCatalogueHistory(tx: Queryer, catalogueId: string, actorId: number): Promise<void> {
  await tx.query(
    `INSERT INTO public.fournisseur_catalogue_prix_history
      (catalogue_id,prix_unitaire,devise,delai_jours,moq,valid_from,recorded_by)
     SELECT id,prix_unitaire,devise,delai_jours,moq,valid_from,$2
       FROM public.fournisseur_catalogue WHERE id=$1::uuid`,
    [catalogueId, actorId]
  );
}

async function applyCanonicalChange(
  tx: Queryer,
  change: ReferenceChange,
  input: ReferenceChangeInput,
  actorId: number
): Promise<void> {
  switch (change.dataset_code) {
    case "HOURLY_RATES": {
      const center = await tx.query(`SELECT id FROM public.centres_frais WHERE id=$1::uuid FOR UPDATE`, [change.record_key]);
      if (!center.rows[0]) throw new HttpError(404, "COST_CENTER_NOT_FOUND", "Centre de frais introuvable.");
      const previous = await tx.query<{ id: string; date_effet: string; date_fin: string | null }>(
        `SELECT id::text, date_effet::text, date_fin::text FROM public.production_cost_center_rates
          WHERE cf_id=$1::uuid ORDER BY date_effet DESC LIMIT 1 FOR UPDATE`, [change.record_key]
      );
      if (previous.rows[0] && previous.rows[0].date_effet >= input.effective_from) {
        throw new HttpError(409, "NON_MONOTONIC_HOURLY_RATE", "Le nouveau taux doit prendre effet après la dernière version existante.");
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO public.production_cost_center_rates
          (cf_id,taux_horaire,devise,date_effet,date_fin,source,commentaire,created_by)
         VALUES ($1::uuid,$2,$3,$4::date,$5::date,$6,$7,$8) RETURNING id::text`,
        [change.record_key, change.value.amount, change.value.currency, input.effective_from, input.effective_to,
          input.source, input.reason, actorId]
      );
      if (previous.rows[0]?.date_fin == null) {
        await tx.query(
          `UPDATE public.production_cost_center_rates
              SET date_fin=$2::date - 1, superseded_at=now(), superseded_by=$3::uuid
            WHERE id=$1::uuid`, [previous.rows[0].id, input.effective_from, inserted.rows[0].id]
        );
      }
      return;
    }
    case "PRODUCTION_CALENDARS": {
      const existing = await tx.query<{ id: string }>(
        `SELECT id::text FROM public.programmation_calendars WHERE id::text=$1 OR code=$1 FOR UPDATE`, [change.record_key]
      );
      if (existing.rows[0]) {
        const duplicate = await tx.query(
          `SELECT 1 FROM public.programmation_calendars WHERE code=$1 AND id<>$2::uuid`,
          [change.value.code, existing.rows[0].id]
        );
        if (duplicate.rows[0]) throw new HttpError(409, "PRODUCTION_CALENDAR_CODE_CONFLICT", "Ce code calendrier est déjà utilisé.");
        await tx.query(
          `UPDATE public.programmation_calendars
              SET code=$2,label=$3,timezone=$4,working_days=$5::smallint[],day_start=$6::time,
                  day_end=$7::time,active=$8,updated_by=$9,updated_at=now()
            WHERE id=$1::uuid`,
          [existing.rows[0].id, change.value.code, change.value.label, change.value.timezone,
            change.value.working_days, change.value.day_start, change.value.day_end, change.value.active, actorId]
        );
      } else {
        await tx.query(
          `INSERT INTO public.programmation_calendars
            (code,label,timezone,working_days,day_start,day_end,active,created_by,updated_by)
           VALUES ($1,$2,$3,$4::smallint[],$5::time,$6::time,$7,$8,$8)`,
          [change.value.code, change.value.label, change.value.timezone, change.value.working_days,
            change.value.day_start, change.value.day_end, change.value.active, actorId]
        );
      }
      return;
    }
    case "MATERIAL_COSTS": {
      await recordSupplierCatalogueHistory(tx, change.record_key, actorId);
      const updated = await tx.query(
        `UPDATE public.fournisseur_catalogue
            SET prix_unitaire=$2,devise=$3,valid_from=$4::date,valid_to=$5::date,updated_by=$6,updated_at=now()
          WHERE id=$1::uuid RETURNING id`,
        [change.record_key, change.value.unit_price, change.value.currency, input.effective_from, input.effective_to, actorId]
      );
      if (!updated.rows[0]) throw new HttpError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "Ligne de catalogue fournisseur introuvable.");
      return;
    }
    case "UNIT_CONVERSIONS": {
      const units = await tx.query<{ code: string }>(
        `SELECT lower(code::text) AS code FROM public.units WHERE lower(code::text)=ANY($1::text[])`,
        [[change.value.purchase_unit.toLowerCase(), change.value.stock_unit.toLowerCase()]]
      );
      const available = new Set(units.rows.map((row) => row.code));
      if (!available.has(change.value.purchase_unit.toLowerCase()) || !available.has(change.value.stock_unit.toLowerCase())) {
        throw new HttpError(422, "UNKNOWN_CANONICAL_UNIT", "Les unités d'achat et de stock doivent exister dans le référentiel canonique.");
      }
      const updated = await tx.query(
        `UPDATE public.fournisseur_catalogue
            SET unite=$2,unite_stock=$3,coef_conversion=$4,updated_by=$5,updated_at=now()
          WHERE id=$1::uuid RETURNING id`,
        [change.record_key, change.value.purchase_unit, change.value.stock_unit, change.value.factor, actorId]
      );
      if (!updated.rows[0]) throw new HttpError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "Ligne de catalogue fournisseur introuvable.");
      return;
    }
    case "SUPPLIER_LEAD_TIMES": {
      await recordSupplierCatalogueHistory(tx, change.record_key, actorId);
      const updated = await tx.query(
        `UPDATE public.fournisseur_catalogue
            SET delai_jours=$2,valid_from=$3::date,valid_to=$4::date,updated_by=$5,updated_at=now()
          WHERE id=$1::uuid RETURNING id`,
        [change.record_key, change.value.lead_time_days, input.effective_from, input.effective_to, actorId]
      );
      if (!updated.rows[0]) throw new HttpError(404, "SUPPLIER_CATALOGUE_NOT_FOUND", "Ligne de catalogue fournisseur introuvable.");
      return;
    }
    case "STOCK_VALUATION": {
      await tx.query(
        `INSERT INTO public.erp_settings
          (key,value_text,value_json,definition,unit,period_start,period_end,source,freshness_at,reliability,created_by,updated_by)
         VALUES ('stock.valuation_method',$1,$2::jsonb,$3,'METHOD',$4::date,$5::date,$6,now(),$7,$8,$8)
         ON CONFLICT (key) DO UPDATE SET
           value_text=EXCLUDED.value_text,value_json=EXCLUDED.value_json,definition=EXCLUDED.definition,
           unit=EXCLUDED.unit,period_start=EXCLUDED.period_start,period_end=EXCLUDED.period_end,
           source=EXCLUDED.source,freshness_at=EXCLUDED.freshness_at,reliability=EXCLUDED.reliability,
           updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [change.value.method, JSON.stringify({ method: change.value.method, definition: "Méthode de valorisation du stock",
          unit: "METHOD", period_start: input.effective_from, period_end: input.effective_to,
          source: input.source, freshness_at: new Date().toISOString(), reliability: input.reliability }),
          "Méthode de valorisation du stock", input.effective_from, input.effective_to, input.source,
          input.reliability, actorId]
      );
      return;
    }
  }
}

export async function repoApplyReferenceChangeSet(
  changeSetId: string,
  idempotencyKey: string,
  audit: ReferenceDataAuditContext
): Promise<{ change_set: ReferenceChangeSetDTO; replayed: boolean }> {
  const client = await db.connect();
  const requestHash = referencePayloadHash({ changeSetId, idempotencyKey });
  try {
    await client.query("BEGIN");
    await ensureInstalled(client);
    const receipt = await client.query<{ request_sha256: string }>(
      `SELECT request_sha256 FROM public.reference_data_decisions
        WHERE actor_user_id=$1 AND decision='APPLIED' AND idempotency_key=$2`, [audit.user_id, idempotencyKey]
    );
    if (receipt.rows[0]) {
      if (receipt.rows[0].request_sha256 !== requestHash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Clé d'application réutilisée.");
      const replay = await client.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid`, [changeSetId]);
      if (!replay.rows[0]) throw new HttpError(404, "REFERENCE_CHANGE_SET_NOT_FOUND", "Proposition introuvable.");
      await client.query("COMMIT");
      return { change_set: mapChangeSet(replay.rows[0]), replayed: true };
    }
    const locked = await client.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid FOR UPDATE`, [changeSetId]);
    const row = locked.rows[0];
    if (!row) throw new HttpError(404, "REFERENCE_CHANGE_SET_NOT_FOUND", "Proposition introuvable.");
    if (row.status !== "APPROVED") throw new HttpError(409, "REFERENCE_CHANGE_SET_NOT_APPROVED", "La proposition doit être approuvée avant application.");
    const effectiveFrom = String(row.effective_from);
    const effectiveTo = textOrNull(row.effective_to);
    if (effectiveFrom > today()) throw new HttpError(409, "REFERENCE_CHANGE_NOT_DUE", `Application possible à partir du ${effectiveFrom}.`);
    if (effectiveTo && effectiveTo < today()) throw new HttpError(409, "REFERENCE_CHANGE_EXPIRED", "La fenêtre d'application est expirée.");
    const changes = row.changes as ReferenceChange[];
    const comparison = await buildComparison(client, changes);
    const snapshotHash = referencePayloadHash(comparison.map(({ dataset_code, record_key, before }) => ({ dataset_code, record_key, before })));
    assertReferenceSnapshotFresh(String(row.expected_snapshot_sha256), snapshotHash);
    const input: ReferenceChangeInput = {
      idempotency_key: String(row.idempotency_key ?? "proposal"),
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      reason: String(row.reason),
      source: String(row.source),
      reliability: row.reliability as ReferenceChangeInput["reliability"],
      changes,
    };
    for (const change of changes) {
      await applyCanonicalChange(client, change, input, audit.user_id);
      const currentVersion = await latestGovernanceVersion(client, change.dataset_code, change.record_key);
      await client.query(
        `INSERT INTO public.reference_data_versions
          (dataset_code,record_key,version,effective_from,effective_to,payload,source,reliability,reason,
           change_set_id,created_by,approved_by)
         VALUES ($1,$2,$3,$4::date,$5::date,$6::jsonb,$7,$8,$9,$10::uuid,$11,$12)`,
        [change.dataset_code, change.record_key, (currentVersion ?? 0) + 1, effectiveFrom, effectiveTo,
          JSON.stringify(afterFor(change)), input.source, input.reliability, input.reason, changeSetId,
          audit.user_id, Number(row.approved_by)]
      );
    }
    await client.query(
      `UPDATE public.reference_data_change_sets
          SET status='APPLIED',applied_by=$2,applied_at=now(),updated_at=now()
        WHERE id=$1::uuid`, [changeSetId, audit.user_id]
    );
    await client.query(
      `INSERT INTO public.reference_data_decisions
        (change_set_id,decision,reason,actor_user_id,idempotency_key,request_sha256)
       VALUES ($1::uuid,'APPLIED',$2,$3,$4,$5)`,
      [changeSetId, `Application contrôlée à la date d'effet ${effectiveFrom}`, audit.user_id, idempotencyKey, requestHash]
    );
    await insertAudit(client, audit, "reference_data.change_set.apply", changeSetId, {
      datasets: changes.map((change) => change.dataset_code), effective_from: effectiveFrom,
      expected_snapshot_sha256: row.expected_snapshot_sha256,
    });
    const updated = await client.query(`SELECT ${CHANGE_SET_SELECT} FROM public.reference_data_change_sets WHERE id=$1::uuid`, [changeSetId]);
    await client.query("COMMIT");
    return { change_set: mapChangeSet(updated.rows[0]), replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function mapRecord(datasetCode: ReferenceDatasetCode, row: Record<string, unknown>): ReferenceRecordDTO {
  const from = textOrNull(row.effective_from);
  const to = textOrNull(row.effective_to);
  return {
    dataset_code: datasetCode,
    record_key: String(row.record_key),
    label: String(row.label),
    value: row.value as Record<string, unknown>,
    effective_from: from,
    effective_to: to,
    source: String(row.source),
    freshness_at: textOrNull(row.freshness_at),
    reliability: row.reliability as ReferenceRecordDTO["reliability"],
    version: row.version == null ? null : Number(row.version),
    status: row.status ? row.status as ReferenceRecordDTO["status"] : statusFor(from, to),
  };
}

export async function repoListReferenceRecords(datasetCode: ReferenceDatasetCode, limit: number): Promise<ReferenceRecordDTO[]> {
  let sql: string;
  switch (datasetCode) {
    case "HOURLY_RATES":
      sql = `SELECT r.cf_id::text AS record_key, cf.code || ' — ' || cf.designation AS label,
        jsonb_build_object('amount',r.taux_horaire::float8,'currency',r.devise) AS value,
        r.date_effet::text AS effective_from,r.date_fin::text AS effective_to,r.source,
        r.created_at::text AS freshness_at,'DECLARED' AS reliability,
        gv.version FROM public.production_cost_center_rates r JOIN public.centres_frais cf ON cf.id=r.cf_id
        LEFT JOIN LATERAL (SELECT version FROM public.reference_data_versions v WHERE v.dataset_code='HOURLY_RATES' AND v.record_key=r.cf_id::text ORDER BY version DESC LIMIT 1) gv ON true
        ORDER BY r.date_effet DESC LIMIT $1`;
      break;
    case "PRODUCTION_CALENDARS":
      sql = `SELECT c.id::text AS record_key,c.code || ' — ' || c.label AS label,
        jsonb_build_object('code',c.code,'label',c.label,'timezone',c.timezone,'working_days',c.working_days,
          'day_start',to_char(c.day_start,'HH24:MI'),'day_end',to_char(c.day_end,'HH24:MI'),'active',c.active) AS value,
        c.created_at::date::text AS effective_from,NULL::text AS effective_to,
        'public.programmation_calendars — saisie auditée' AS source,c.updated_at::text AS freshness_at,
        'DECLARED' AS reliability,gv.version
        FROM public.programmation_calendars c
        LEFT JOIN LATERAL (SELECT version FROM public.reference_data_versions v WHERE v.dataset_code='PRODUCTION_CALENDARS' AND v.record_key IN (c.id::text,c.code) ORDER BY version DESC LIMIT 1) gv ON true
        ORDER BY c.active DESC,c.code LIMIT $1`;
      break;
    case "MATERIAL_COSTS":
      sql = `SELECT fc.id::text AS record_key,COALESCE(f.code,f.code_fournisseur,'?') || ' — ' || fc.designation AS label,
        jsonb_build_object('unit_price',fc.prix_unitaire::float8,'currency',COALESCE(fc.devise,'EUR'),'purchase_unit',fc.unite) AS value,
        fc.valid_from::text AS effective_from,fc.valid_to::text AS effective_to,
        'public.fournisseur_catalogue' AS source,fc.updated_at::text AS freshness_at,
        CASE WHEN fc.prix_unitaire IS NULL THEN 'UNAVAILABLE' ELSE 'DECLARED' END AS reliability,gv.version
        FROM public.fournisseur_catalogue fc JOIN public.fournisseurs f ON f.id=fc.fournisseur_id
        LEFT JOIN LATERAL (SELECT version FROM public.reference_data_versions v WHERE v.dataset_code='MATERIAL_COSTS' AND v.record_key=fc.id::text ORDER BY version DESC LIMIT 1) gv ON true
        WHERE fc.actif ORDER BY fc.updated_at DESC LIMIT $1`;
      break;
    case "UNIT_CONVERSIONS":
      sql = `SELECT fc.id::text AS record_key,COALESCE(f.code,f.code_fournisseur,'?') || ' — ' || fc.designation AS label,
        jsonb_build_object('purchase_unit',fc.unite,'stock_unit',fc.unite_stock,'factor',fc.coef_conversion::float8) AS value,
        fc.valid_from::text AS effective_from,fc.valid_to::text AS effective_to,'public.units + public.fournisseur_catalogue' AS source,
        fc.updated_at::text AS freshness_at,CASE WHEN fc.unite IS NULL OR fc.unite_stock IS NULL OR fc.coef_conversion IS NULL THEN 'UNAVAILABLE' ELSE 'VERIFIED' END AS reliability,gv.version
        FROM public.fournisseur_catalogue fc JOIN public.fournisseurs f ON f.id=fc.fournisseur_id
        LEFT JOIN LATERAL (SELECT version FROM public.reference_data_versions v WHERE v.dataset_code='UNIT_CONVERSIONS' AND v.record_key=fc.id::text ORDER BY version DESC LIMIT 1) gv ON true
        WHERE fc.actif ORDER BY fc.updated_at DESC LIMIT $1`;
      break;
    case "SUPPLIER_LEAD_TIMES":
      sql = `SELECT fc.id::text AS record_key,COALESCE(f.code,f.code_fournisseur,'?') || ' — ' || fc.designation AS label,
        jsonb_build_object('lead_time_days',fc.delai_jours) AS value,fc.valid_from::text AS effective_from,fc.valid_to::text AS effective_to,
        'public.fournisseur_catalogue' AS source,fc.updated_at::text AS freshness_at,
        CASE WHEN fc.delai_jours IS NULL THEN 'UNAVAILABLE' ELSE 'DECLARED' END AS reliability,gv.version
        FROM public.fournisseur_catalogue fc JOIN public.fournisseurs f ON f.id=fc.fournisseur_id
        LEFT JOIN LATERAL (SELECT version FROM public.reference_data_versions v WHERE v.dataset_code='SUPPLIER_LEAD_TIMES' AND v.record_key=fc.id::text ORDER BY version DESC LIMIT 1) gv ON true
        WHERE fc.actif ORDER BY fc.updated_at DESC LIMIT $1`;
      break;
    case "STOCK_VALUATION":
      sql = `SELECT s.key AS record_key,'Valorisation du stock' AS label,
        jsonb_build_object('method',COALESCE(s.value_text,s.value_json->>'method')) AS value,
        s.period_start::text AS effective_from,s.period_end::text AS effective_to,COALESCE(s.source,'Non renseignée') AS source,
        COALESCE(s.freshness_at,s.updated_at)::text AS freshness_at,
        CASE WHEN s.value_text IS NULL AND s.value_json->>'method' IS NULL THEN 'UNAVAILABLE' ELSE COALESCE(s.reliability,'DECLARED') END AS reliability,gv.version
        FROM public.erp_settings s
        LEFT JOIN LATERAL (SELECT version FROM public.reference_data_versions v WHERE v.dataset_code='STOCK_VALUATION' AND v.record_key=s.key ORDER BY version DESC LIMIT 1) gv ON true
        WHERE s.key='stock.valuation_method' LIMIT $1`;
      break;
    case "MARGIN_RATE_CARDS":
      if (!(await relationExists(db, "public.margin_rate_versions"))) return [];
      sql = `SELECT v.id::text AS record_key,v.code || ' v' || v.version AS label,
        jsonb_build_object('code',v.code,'version',v.version,'currency',v.currency,'rates',COUNT(r.id)) AS value,
        v.effective_from::text,v.effective_to::text,v.source,v.created_at::text AS freshness_at,
        'DECLARED' AS reliability,v.version
        FROM public.margin_rate_versions v LEFT JOIN public.margin_rates r ON r.rate_version_id=v.id
        GROUP BY v.id ORDER BY v.effective_from DESC LIMIT $1`;
      break;
    case "STOCK_DECISION_POLICIES":
      if (!(await relationExists(db, "public.stock_intelligence_policy_versions"))) return [];
      sql = `SELECT p.id::text AS record_key,'Politique stock du ' || p.valid_from::text AS label,
        to_jsonb(p) - 'id' - 'created_by' AS value,p.valid_from::text AS effective_from,NULL::text AS effective_to,
        'public.stock_intelligence_policy_versions' AS source,p.created_at::text AS freshness_at,
        'DECLARED' AS reliability,row_number() OVER (ORDER BY p.valid_from)::integer AS version
        FROM public.stock_intelligence_policy_versions p ORDER BY p.valid_from DESC LIMIT $1`;
      break;
  }
  const result = await db.query(sql, [limit]);
  return result.rows.map((row) => mapRecord(datasetCode, row));
}

type SummaryStats = { record_count: string; missing_count: string; freshness_at: string | null };

async function summaryStats(datasetCode: ReferenceDatasetCode): Promise<SummaryStats> {
  if (datasetCode === "MARGIN_RATE_CARDS" && !(await relationExists(db, "public.margin_rate_versions"))) {
    return { record_count: "0", missing_count: "1", freshness_at: null };
  }
  if (datasetCode === "STOCK_DECISION_POLICIES" && !(await relationExists(db, "public.stock_intelligence_policy_versions"))) {
    return { record_count: "0", missing_count: "1", freshness_at: null };
  }
  const queries: Record<ReferenceDatasetCode, string> = {
    HOURLY_RATES: `SELECT count(DISTINCT c.id)::text record_count,
      count(DISTINCT c.id) FILTER (WHERE current_rate.id IS NULL)::text missing_count,max(r.created_at)::text freshness_at
      FROM public.centres_frais c LEFT JOIN public.production_cost_center_rates r ON r.cf_id=c.id
      LEFT JOIN LATERAL (SELECT id FROM public.production_cost_center_rates x WHERE x.cf_id=c.id AND x.date_effet<=CURRENT_DATE AND (x.date_fin IS NULL OR x.date_fin>=CURRENT_DATE) ORDER BY x.date_effet DESC LIMIT 1) current_rate ON true
      WHERE c.statut='ACTIF' AND c.archived_at IS NULL`,
    PRODUCTION_CALENDARS: `SELECT count(*)::text record_count,count(*) FILTER (WHERE NOT active OR cardinality(working_days)=0 OR day_start>=day_end)::text missing_count,max(updated_at)::text freshness_at FROM public.programmation_calendars`,
    MATERIAL_COSTS: `SELECT count(*)::text record_count,count(*) FILTER (WHERE prix_unitaire IS NULL)::text missing_count,max(updated_at)::text freshness_at FROM public.fournisseur_catalogue WHERE actif`,
    UNIT_CONVERSIONS: `SELECT count(*)::text record_count,count(*) FILTER (WHERE unite IS NULL OR unite_stock IS NULL OR coef_conversion IS NULL)::text missing_count,max(updated_at)::text freshness_at FROM public.fournisseur_catalogue WHERE actif`,
    SUPPLIER_LEAD_TIMES: `SELECT count(*)::text record_count,count(*) FILTER (WHERE delai_jours IS NULL)::text missing_count,max(updated_at)::text freshness_at FROM public.fournisseur_catalogue WHERE actif`,
    STOCK_VALUATION: `SELECT count(*)::text record_count,count(*) FILTER (WHERE value_text IS NULL AND value_json->>'method' IS NULL)::text missing_count,max(COALESCE(freshness_at,updated_at))::text freshness_at FROM public.erp_settings WHERE key='stock.valuation_method'`,
    MARGIN_RATE_CARDS: `SELECT count(*)::text record_count,0::text missing_count,max(created_at)::text freshness_at FROM public.margin_rate_versions`,
    STOCK_DECISION_POLICIES: `SELECT count(*)::text record_count,CASE WHEN count(*)=0 THEN '1' ELSE '0' END missing_count,max(created_at)::text freshness_at FROM public.stock_intelligence_policy_versions`,
  };
  const result = await db.query<SummaryStats>(queries[datasetCode]);
  return result.rows[0] ?? { record_count: "0", missing_count: "0", freshness_at: null };
}

export async function repoReferenceCatalog(): Promise<ReferenceDatasetSummaryDTO[]> {
  const output: ReferenceDatasetSummaryDTO[] = [];
  for (const definition of REFERENCE_DATASETS) {
    const stats = await summaryStats(definition.code);
    const count = Number(stats.record_count);
    const missing = Number(stats.missing_count);
    output.push({
      ...definition,
      affected_modules: [...definition.affected_modules],
      record_count: count,
      missing_count: missing,
      freshness_at: stats.freshness_at,
      reliability: count === 0 ? "UNAVAILABLE" : missing > 0 ? "PARTIAL" : definition.code === "UNIT_CONVERSIONS" ? "VERIFIED" : "DECLARED",
    });
  }
  return output;
}

export async function repoExportReferenceData(datasetCodes: ReferenceDatasetCode[]): Promise<Record<string, unknown>> {
  const datasets: Record<string, unknown> = {};
  for (const code of datasetCodes) datasets[code] = await repoListReferenceRecords(code, 500);
  const payload = { format: "CERP_REFERENCE_DATA_EXPORT", format_version: 1, exported_at: new Date().toISOString(), datasets };
  return { ...payload, sha256: referencePayloadHash(payload) };
}
