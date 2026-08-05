import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  assertExplicitPolicyValidation,
  assertTemplateIsSafe,
  assertValidTimeZone,
  daysBetweenDateOnly,
  dueCadenceSteps,
  normalizeCadenceDays,
  reminderSuggestionKey,
  renderReminderTemplate,
  requestHash,
  retryDelayMinutes,
  type ReminderTemplateContext,
} from "../domain/reminder-policy";
import type {
  ReminderHistoryEvent,
  ReminderListResult,
  ReminderPolicy,
  ReminderReadiness,
  ReminderSuggestion,
} from "../types/reminders.types";
import type {
  ApproveReminderDTO,
  CancelReminderDTO,
  CreateReminderPolicyDTO,
  ListReminderSuggestionsDTO,
  ReminderClientPreferenceDTO,
  RetireReminderPolicyDTO,
  RetryReminderDTO,
  ValidateReminderPolicyDTO,
} from "../validators/reminders.validators";
import {
  insertGlobalFinanceAudit,
  type FinanceActorContext,
} from "./workflow.repository.shared";

type Queryer = Pick<PoolClient, "query">;

type CommandReplay = {
  idempotency_key: string;
  request_hash: string;
  result_payload: Record<string, unknown>;
};

type ReminderCandidate = {
  facture_id: number;
  facture_number: string;
  client_id: string;
  client_name: string;
  due_date: string;
  outstanding_amount: string;
  currency: string;
  recipient_contact_id: string | null;
  recipient_email: string | null;
  preference_channel: "EMAIL" | "NONE" | null;
  opted_out: boolean | null;
  restricted_processing: boolean | null;
  preference_lawful_basis: string | null;
  consent_granted: boolean | null;
  attachment_document_id: string | null;
};

export type ReminderClaim = {
  suggestionId: string;
  claimToken: string;
  attemptNo: number;
  actor: FinanceActorContext | null;
  command: { idempotencyKey: string; requestHash: string; commandType: string } | null;
  message: {
    idempotencyKey: string;
    recipient: string;
    subject: string;
    body: string;
    attachmentDocumentId: string | null;
  };
  retryDelaysMinutes: number[];
};

export type ReminderGenerationResult = {
  generated: number;
  blocked: number;
  cancelled: number;
  already_present: number;
};

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42P01";
}

function policyFromRow(row: Record<string, unknown>): ReminderPolicy {
  return {
    id: String(row.id),
    version: Number(row.version),
    row_version: Number(row.row_version),
    name: String(row.name),
    status: row.status as ReminderPolicy["status"],
    timezone: String(row.timezone),
    channel: "EMAIL",
    delivery_mode: row.delivery_mode as ReminderPolicy["delivery_mode"],
    lawful_basis: row.lawful_basis as ReminderPolicy["lawful_basis"],
    consent_required: row.consent_required === true,
    cadence_days: (row.cadence_days as number[] | null) ?? [],
    retry_delays_minutes: (row.retry_delays_minutes as number[] | null) ?? [],
    template_subject: String(row.template_subject),
    template_body: String(row.template_body),
    attach_invoice_pdf: row.attach_invoice_pdf === true,
    validated_at: row.validated_at == null ? null : String(row.validated_at),
    validated_by: row.validated_by == null ? null : Number(row.validated_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function suggestionFromRow(row: Record<string, unknown>): ReminderSuggestion {
  return {
    id: String(row.id),
    facture_id: Number(row.facture_id),
    facture_number: String(row.facture_number),
    client_id: String(row.client_id),
    client_name: String(row.client_name),
    policy_id: String(row.policy_id),
    policy_version: Number(row.policy_version),
    cadence_step_days: Number(row.cadence_step_days),
    due_date: String(row.due_date).slice(0, 10),
    days_overdue: Number(row.days_overdue),
    outstanding_amount: String(row.outstanding_amount),
    currency: String(row.currency),
    channel: row.channel as ReminderSuggestion["channel"],
    recipient_contact_id: row.recipient_contact_id == null ? null : String(row.recipient_contact_id),
    recipient_hint: row.recipient_hint == null ? null : String(row.recipient_hint),
    subject_snapshot: String(row.subject_snapshot),
    body_snapshot: String(row.body_snapshot),
    attachment_document_id:
      row.attachment_document_id == null ? null : String(row.attachment_document_id),
    status: row.status as ReminderSuggestion["status"],
    row_version: Number(row.row_version),
    attempt_count: Number(row.attempt_count),
    next_attempt_at: row.next_attempt_at == null ? null : String(row.next_attempt_at),
    last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
    last_error_message: row.last_error_message == null ? null : String(row.last_error_message),
    approved_at: row.approved_at == null ? null : String(row.approved_at),
    approved_by: row.approved_by == null ? null : Number(row.approved_by),
    sent_at: row.sent_at == null ? null : String(row.sent_at),
    provider_message_id:
      row.provider_message_id == null ? null : String(row.provider_message_id),
    cancelled_at: row.cancelled_at == null ? null : String(row.cancelled_at),
    cancellation_reason:
      row.cancellation_reason == null ? null : String(row.cancellation_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

const SUGGESTION_SELECT = `
  SELECT
    s.*,
    COALESCE(f.legal_number, f.numero, f.draft_reference, f.id::text) AS facture_number,
    c.company_name AS client_name
  FROM public.adv_reminder_suggestions s
  JOIN public.facture f ON f.id = s.facture_id
  JOIN public.clients c ON c.client_id = s.client_id
`;

async function insertEvent(params: {
  queryer: Queryer;
  suggestionId: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  actorUserId: number | null;
  details?: Record<string, unknown>;
}): Promise<void> {
  await params.queryer.query(
    `
      INSERT INTO public.adv_reminder_events (
        suggestion_id, event_type, from_status, to_status, actor_user_id, details
      ) VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb)
    `,
    [
      params.suggestionId,
      params.eventType,
      params.fromStatus,
      params.toStatus,
      params.actorUserId,
      JSON.stringify(params.details ?? {}),
    ]
  );
}

async function acquireCommand(params: {
  client: PoolClient;
  actorUserId: number;
  idempotencyKey: string;
  commandType: string;
  payload: unknown;
}): Promise<{ requestHash: string; replay: Record<string, unknown> | null }> {
  const hash = requestHash(params.commandType, params.payload);
  await params.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `adv-reminder:${params.actorUserId}:${params.idempotencyKey}`,
  ]);
  const existing = await params.client.query<CommandReplay>(
    `
      SELECT idempotency_key, request_hash, result_payload
      FROM public.adv_reminder_command_receipts
      WHERE actor_user_id=$1 AND idempotency_key=$2
      LIMIT 1
    `,
    [params.actorUserId, params.idempotencyKey]
  );
  const receipt = existing.rows[0];
  if (receipt && receipt.request_hash !== hash) {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Cette clé d'idempotence a déjà été utilisée avec une autre demande."
    );
  }
  return { requestHash: hash, replay: receipt?.result_payload ?? null };
}

async function saveCommand(params: {
  client: PoolClient;
  actorUserId: number;
  idempotencyKey: string;
  requestHash: string;
  commandType: string;
  policyId?: string | null;
  suggestionId?: string | null;
  result: Record<string, unknown>;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO public.adv_reminder_command_receipts (
        actor_user_id,idempotency_key,request_hash,command_type,policy_id,suggestion_id,result_payload
      ) VALUES ($1,$2,$3,$4,$5::uuid,$6::uuid,$7::jsonb)
    `,
    [
      params.actorUserId,
      params.idempotencyKey,
      params.requestHash,
      params.commandType,
      params.policyId ?? null,
      params.suggestionId ?? null,
      JSON.stringify(params.result),
    ]
  );
}

async function audit(params: {
  client: PoolClient;
  actor: FinanceActorContext;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await insertGlobalFinanceAudit(params);
}

export async function repoListReminderPolicies(): Promise<ReminderPolicy[]> {
  const result = await pool.query(
    `SELECT * FROM public.adv_reminder_policies ORDER BY version DESC`
  );
  return result.rows.map((row) => policyFromRow(row));
}

export async function repoCreateReminderPolicy(
  input: CreateReminderPolicyDTO,
  actor: FinanceActorContext
): Promise<ReminderPolicy> {
  assertValidTimeZone(input.timezone);
  assertTemplateIsSafe(input.template_subject, input.template_body);
  const cadenceDays = normalizeCadenceDays(input.cadence_days);
  if (input.lawful_basis === "CONSENT" && !input.consent_required) {
    throw new HttpError(
      400,
      "REMINDER_CONSENT_POLICY_INVALID",
      "Une politique fondée sur le consentement doit exiger un consentement explicite."
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('adv-reminder-policy-version'))");
    const inserted = await client.query(
      `
        INSERT INTO public.adv_reminder_policies (
          version,name,timezone,channel,delivery_mode,lawful_basis,consent_required,
          cadence_days,retry_delays_minutes,template_subject,template_body,attach_invoice_pdf,
          created_by,updated_by
        )
        SELECT COALESCE(MAX(version),0)+1,$1,$2,'EMAIL',$3,$4,$5,$6::smallint[],$7::integer[],$8,$9,$10,$11,$11
        FROM public.adv_reminder_policies
        RETURNING *
      `,
      [
        input.name,
        input.timezone,
        input.delivery_mode,
        input.lawful_basis,
        input.consent_required,
        cadenceDays,
        input.retry_delays_minutes,
        input.template_subject,
        input.template_body,
        input.attach_invoice_pdf,
        actor.userId,
      ]
    );
    const policy = policyFromRow(inserted.rows[0]);
    await audit({
      client,
      actor,
      action: "facturation.reminder_policy_created",
      entityType: "adv_reminder_policy",
      entityId: policy.id,
      details: { version: policy.version, status: policy.status },
    });
    await client.query("COMMIT");
    return policy;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoValidateReminderPolicy(params: {
  policyId: string;
  input: ValidateReminderPolicyDTO;
  actor: FinanceActorContext;
}): Promise<Record<string, unknown>> {
  assertExplicitPolicyValidation(params.input.confirmation);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const command = await acquireCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      commandType: "REMINDER_POLICY_VALIDATE",
      payload: { policyId: params.policyId, expectedVersion: params.input.expected_version },
    });
    if (command.replay) {
      await client.query("COMMIT");
      return { ...command.replay, idempotent_replay: true };
    }
    const locked = await client.query(
      `SELECT * FROM public.adv_reminder_policies WHERE id=$1::uuid FOR UPDATE`,
      [params.policyId]
    );
    const row = locked.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new HttpError(404, "REMINDER_POLICY_NOT_FOUND", "Politique de relance introuvable.");
    if (Number(row.row_version) !== params.input.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La politique a changé; rechargez-la.");
    }
    if (row.status !== "DRAFT") {
      throw new HttpError(409, "REMINDER_POLICY_NOT_DRAFT", "Seule une politique brouillon peut être validée.");
    }
    assertValidTimeZone(String(row.timezone));
    assertTemplateIsSafe(String(row.template_subject), String(row.template_body));
    normalizeCadenceDays((row.cadence_days as number[] | null) ?? []);

    await client.query(
      `
        UPDATE public.adv_reminder_policies
        SET status='RETIRED', retired_at=now(), retired_by=$2, updated_by=$2,
            row_version=row_version+1, updated_at=now()
        WHERE status='VALIDATED' AND id<>$1::uuid
      `,
      [params.policyId, params.actor.userId]
    );
    const updated = await client.query(
      `
        UPDATE public.adv_reminder_policies
        SET status='VALIDATED', validated_at=now(), validated_by=$2, updated_by=$2,
            row_version=row_version+1, updated_at=now()
        WHERE id=$1::uuid
        RETURNING *
      `,
      [params.policyId, params.actor.userId]
    );
    const policy = policyFromRow(updated.rows[0]);
    const result = { policy, idempotent_replay: false };
    await saveCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      requestHash: command.requestHash,
      commandType: "REMINDER_POLICY_VALIDATE",
      policyId: params.policyId,
      result,
    });
    await audit({
      client,
      actor: params.actor,
      action: "facturation.reminder_policy_validated",
      entityType: "adv_reminder_policy",
      entityId: params.policyId,
      details: { version: policy.version, delivery_mode: policy.delivery_mode },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string })?.code === "40001") {
      throw new HttpError(409, "REMINDER_POLICY_RETRY", "Une autre validation a eu lieu; rechargez les politiques.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRetireReminderPolicy(params: {
  policyId: string;
  input: RetireReminderPolicyDTO;
  actor: FinanceActorContext;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = await acquireCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      commandType: "REMINDER_POLICY_RETIRE",
      payload: { policyId: params.policyId, ...params.input },
    });
    if (command.replay) {
      await client.query("COMMIT");
      return { ...command.replay, idempotent_replay: true };
    }
    const result = await client.query(
      `
        UPDATE public.adv_reminder_policies
        SET status='RETIRED',retired_at=now(),retired_by=$3,retirement_reason=$4,
            updated_by=$3,row_version=row_version+1,updated_at=now()
        WHERE id=$1::uuid AND row_version=$2 AND status IN ('DRAFT','VALIDATED')
        RETURNING *
      `,
      [params.policyId, params.input.expected_version, params.actor.userId, params.input.reason]
    );
    if (!result.rows[0]) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "La politique a changé ou est déjà retirée.");
    }
    const policy = policyFromRow(result.rows[0]);
    const payload = { policy, idempotent_replay: false };
    await saveCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      requestHash: command.requestHash,
      commandType: "REMINDER_POLICY_RETIRE",
      policyId: params.policyId,
      result: payload,
    });
    await audit({
      client,
      actor: params.actor,
      action: "facturation.reminder_policy_retired",
      entityType: "adv_reminder_policy",
      entityId: params.policyId,
      details: { version: policy.version, reason: params.input.reason },
    });
    await client.query("COMMIT");
    return payload;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoGetReminderReadiness(environment = process.env): Promise<ReminderReadiness> {
  const provider = (environment.ADV_REMINDERS_PROVIDER ?? "sandbox").trim().toLowerCase();
  const jobEnabled = (environment.ADV_REMINDERS_JOB_ENABLED ?? "false").trim().toLowerCase() === "true";
  let activePolicy: ReminderPolicy | null = null;
  try {
    const result = await pool.query(
      `SELECT * FROM public.adv_reminder_policies WHERE status='VALIDATED' ORDER BY version DESC LIMIT 1`
    );
    activePolicy = result.rows[0] ? policyFromRow(result.rows[0]) : null;
  } catch (error) {
    if (isUndefinedTable(error)) {
      return {
        ready: false,
        reason: "SCHEMA_NOT_INSTALLED",
        provider: provider === "sandbox" ? "sandbox" : "invalid",
        job_enabled: jobEnabled,
        autonomous_delivery: false,
        active_policy: null,
      };
    }
    throw error;
  }
  const reason: ReminderReadiness["reason"] =
    provider !== "sandbox" ? "PROVIDER_NOT_SANDBOX" : activePolicy ? "READY" : "NO_VALIDATED_POLICY";
  return {
    ready: reason === "READY",
    reason,
    provider: provider === "sandbox" ? "sandbox" : "invalid",
    job_enabled: jobEnabled,
    autonomous_delivery: false,
    active_policy: activePolicy,
  };
}

export async function repoListReminderSuggestions(
  filters: ListReminderSuggestionsDTO
): Promise<ReminderListResult> {
  const where: string[] = [];
  const values: unknown[] = [];
  const push = (value: unknown): string => {
    values.push(value);
    return `$${values.length}`;
  };
  if (filters.status) where.push(`s.status=${push(filters.status)}`);
  if (filters.facture_id) where.push(`s.facture_id=${push(filters.facture_id)}`);
  if (filters.client_id) where.push(`s.client_id=${push(filters.client_id)}::uuid`);
  if (filters.from_due_date) where.push(`s.due_date>=${push(filters.from_due_date)}::date`);
  if (filters.to_due_date) where.push(`s.due_date<=${push(filters.to_due_date)}::date`);
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const count = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::integer AS total FROM public.adv_reminder_suggestions s ${whereSql}`,
    values
  );
  const data = await pool.query(
    `${SUGGESTION_SELECT} ${whereSql} ORDER BY s.updated_at DESC,s.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, filters.limit, filters.offset]
  );
  return {
    items: data.rows.map((row) => suggestionFromRow(row)),
    total: count.rows[0]?.total ?? 0,
    limit: filters.limit,
    offset: filters.offset,
  };
}

async function loadValidatedPolicy(queryer: Queryer): Promise<ReminderPolicy | null> {
  const result = await queryer.query(
    `SELECT * FROM public.adv_reminder_policies WHERE status='VALIDATED' ORDER BY version DESC LIMIT 1`
  );
  return result.rows[0] ? policyFromRow(result.rows[0]) : null;
}

async function loadCandidates(queryer: Queryer, asOfDate: string, limit: number): Promise<ReminderCandidate[]> {
  const result = await queryer.query<ReminderCandidate>(
    `
      SELECT
        f.id AS facture_id,
        COALESCE(f.legal_number,f.numero,f.draft_reference,f.id::text) AS facture_number,
        f.client_id::text AS client_id,
        c.company_name AS client_name,
        COALESCE(open_due.due_date,f.date_echeance)::text AS due_date,
        GREATEST(f.total_ttc::numeric(18,2)-settlement.settled_ttc,0)::numeric(18,2)::text AS outstanding_amount,
        COALESCE(f.currency,'EUR') AS currency,
        pref.recipient_contact_id::text AS recipient_contact_id,
        COALESCE(selected_contact.email,primary_contact.email,c.email) AS recipient_email,
        pref.channel AS preference_channel,
        pref.opted_out,
        pref.restricted_processing,
        pref.lawful_basis AS preference_lawful_basis,
        pref.consent_granted,
        CASE WHEN $3::boolean THEN invoice_document.document_id ELSE NULL END AS attachment_document_id
      FROM public.facture f
      JOIN public.clients c ON c.client_id=f.client_id
      LEFT JOIN public.adv_reminder_client_preferences pref ON pref.client_id=f.client_id
      LEFT JOIN public.contacts selected_contact
        ON selected_contact.contact_id=pref.recipient_contact_id
       AND selected_contact.client_id=f.client_id
       AND selected_contact.archived_at IS NULL
      LEFT JOIN public.contacts primary_contact
        ON primary_contact.contact_id=c.contact_id
       AND primary_contact.client_id=f.client_id
       AND primary_contact.archived_at IS NULL
      LEFT JOIN LATERAL (
        SELECT MIN(fe.due_date) AS due_date
        FROM public.facture_echeance fe
        WHERE fe.facture_id=f.id AND fe.status IN ('OPEN','PARTIALLY_PAID','OVERDUE')
      ) open_due ON TRUE
      CROSS JOIN LATERAL (
        SELECT (
          COALESCE((
            SELECT SUM(pa.amount_ttc)
            FROM public.paiement_allocations pa
            JOIN public.paiement p ON p.id=pa.paiement_id
            WHERE pa.facture_id=f.id AND p.status NOT IN ('REJECTED','REVERSED')
              AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
          ),0)
          + COALESCE((
            SELECT SUM(p.montant)
            FROM public.paiement p
            WHERE p.facture_id=f.id AND p.status NOT IN ('REJECTED','REVERSED')
              AND p.workflow_status<>'REVERSED' AND p.reversal_of_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.paiement_allocations pa WHERE pa.paiement_id=p.id)
          ),0)
          + COALESCE((
            SELECT SUM(asa.amount_ttc)
            FROM public.avoir_source_allocations asa
            WHERE asa.facture_id=f.id AND asa.allocation_status='CONSUMED'
          ),0)
          + COALESCE((
            SELECT SUM(a.total_ttc)
            FROM public.avoir a
            WHERE a.facture_id=f.id AND a.statut IN ('ISSUED','emis','emise','envoyee')
              AND NOT EXISTS (SELECT 1 FROM public.avoir_source_allocations asa WHERE asa.avoir_id=a.id)
          ),0)
        )::numeric(18,2) AS settled_ttc
      ) settlement
      LEFT JOIN LATERAL (
        SELECT fd.document_id::text AS document_id
        FROM public.facture_documents fd
        WHERE fd.facture_id=f.id
        ORDER BY fd.document_id DESC
        LIMIT 1
      ) invoice_document ON TRUE
      WHERE (f.document_status='ISSUED' OR f.statut IN ('ISSUED','PARTIALLY_PAID','emis','emise','envoyee','partielle'))
        AND COALESCE(open_due.due_date,f.date_echeance) IS NOT NULL
        AND COALESCE(open_due.due_date,f.date_echeance)<=$1::date
        AND f.total_ttc::numeric(18,2)>settlement.settled_ttc
      ORDER BY COALESCE(open_due.due_date,f.date_echeance),f.id
      LIMIT $2
    `,
    [asOfDate, limit, true]
  );
  return result.rows;
}

function candidateDisposition(candidate: ReminderCandidate, policy: ReminderPolicy): {
  status: "SUGGESTED" | "BLOCKED" | "CANCELLED";
  reason: string | null;
  channel: "EMAIL" | "NONE";
} {
  if (candidate.opted_out === true) return { status: "CANCELLED", reason: "CLIENT_OPT_OUT", channel: "NONE" };
  if (candidate.restricted_processing === true) {
    return { status: "CANCELLED", reason: "PROCESSING_RESTRICTED", channel: "NONE" };
  }
  const channel = candidate.preference_channel ?? "EMAIL";
  if (channel === "NONE") return { status: "CANCELLED", reason: "CHANNEL_DISABLED", channel };
  if (!candidate.recipient_email?.trim()) return { status: "BLOCKED", reason: "RECIPIENT_MISSING", channel };
  if ((policy.consent_required || policy.lawful_basis === "CONSENT") && candidate.consent_granted !== true) {
    return { status: "BLOCKED", reason: "CONSENT_MISSING", channel };
  }
  return { status: "SUGGESTED", reason: null, channel };
}

export async function repoGenerateReminderSuggestions(params: {
  asOfDate: string;
  limit: number;
  actor: FinanceActorContext | null;
}): Promise<ReminderGenerationResult> {
  const client = await pool.connect();
  const output: ReminderGenerationResult = { generated: 0, blocked: 0, cancelled: 0, already_present: 0 };
  try {
    await client.query("BEGIN");
    const policy = await loadValidatedPolicy(client);
    if (!policy) {
      throw new HttpError(
        409,
        "REMINDER_POLICY_NOT_VALIDATED",
        "Aucune suggestion ne peut être générée sans politique validée."
      );
    }
    const candidates = await loadCandidates(client, params.asOfDate, params.limit);
    for (const candidate of candidates) {
      const daysOverdue = daysBetweenDateOnly(params.asOfDate, candidate.due_date.slice(0, 10));
      const context: ReminderTemplateContext = {
        client_name: candidate.client_name,
        invoice_number: candidate.facture_number,
        due_date: candidate.due_date.slice(0, 10),
        outstanding_amount: candidate.outstanding_amount,
        currency: candidate.currency,
        days_overdue: String(daysOverdue),
      };
      for (const cadenceStep of dueCadenceSteps(policy.cadence_days, daysOverdue)) {
        const disposition = candidateDisposition(candidate, policy);
        const result = await client.query<{ id: string }>(
          `
            INSERT INTO public.adv_reminder_suggestions (
              facture_id,client_id,policy_id,policy_version,cadence_step_days,due_date,days_overdue,
              outstanding_amount,currency,channel,recipient_contact_id,recipient_hint,
              subject_snapshot,body_snapshot,attachment_document_id,status,idempotency_key,
              cancellation_reason,cancelled_at,next_attempt_at
            ) VALUES (
              $1,$2::uuid,$3::uuid,$4,$5,$6::date,$7,$8::numeric,$9,$10,$11::uuid,$12,
              $13,$14,$15::uuid,$16,$17,$18,
              CASE WHEN $16='CANCELLED' THEN now() ELSE NULL END,
              CASE WHEN $16='SUGGESTED' THEN now() ELSE NULL END
            )
            ON CONFLICT (facture_id,cadence_step_days) DO NOTHING
            RETURNING id::text
          `,
          [
            candidate.facture_id,
            candidate.client_id,
            policy.id,
            policy.version,
            cadenceStep,
            candidate.due_date,
            daysOverdue,
            candidate.outstanding_amount,
            candidate.currency,
            disposition.channel,
            candidate.recipient_contact_id,
            candidate.recipient_contact_id ? "Contact client configuré" : "Adresse générale du client",
            renderReminderTemplate(policy.template_subject, context),
            renderReminderTemplate(policy.template_body, context),
            policy.attach_invoice_pdf ? candidate.attachment_document_id : null,
            disposition.status,
            reminderSuggestionKey(candidate.facture_id, cadenceStep),
            disposition.reason,
          ]
        );
        const suggestionId = result.rows[0]?.id;
        if (!suggestionId) {
          output.already_present += 1;
          continue;
        }
        if (disposition.status === "SUGGESTED") output.generated += 1;
        else if (disposition.status === "BLOCKED") output.blocked += 1;
        else output.cancelled += 1;
        await insertEvent({
          queryer: client,
          suggestionId,
          eventType: "SUGGESTION_GENERATED",
          fromStatus: null,
          toStatus: disposition.status,
          actorUserId: params.actor?.userId ?? null,
          details: {
            cadence_step_days: cadenceStep,
            policy_version: policy.version,
            reason_code: disposition.reason,
          },
        });
      }
    }
    if (params.actor) {
      await audit({
        client,
        actor: params.actor,
        action: "facturation.reminder_suggestions_generated",
        entityType: "adv_reminder_cycle",
        entityId: params.asOfDate,
        details: output,
      });
    }
    await client.query("COMMIT");
    return output;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function fetchSuggestion(queryer: Queryer, suggestionId: string): Promise<ReminderSuggestion | null> {
  const result = await queryer.query(
    `${SUGGESTION_SELECT} WHERE s.id=$1::uuid`,
    [suggestionId]
  );
  return result.rows[0] ? suggestionFromRow(result.rows[0]) : null;
}

export async function repoApproveReminder(params: {
  suggestionId: string;
  input: ApproveReminderDTO;
  actor: FinanceActorContext;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = await acquireCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      commandType: "REMINDER_APPROVE",
      payload: { suggestionId: params.suggestionId, expectedVersion: params.input.expected_version },
    });
    if (command.replay) {
      await client.query("COMMIT");
      return { ...command.replay, idempotent_replay: true };
    }
    const updated = await client.query<{ id: string }>(
      `
        UPDATE public.adv_reminder_suggestions s
        SET status='APPROVED',approved_at=now(),approved_by=$3,row_version=row_version+1,
            next_attempt_at=now(),updated_at=now()
        FROM public.adv_reminder_policies p
        WHERE s.id=$1::uuid AND s.row_version=$2 AND s.status='SUGGESTED'
          AND p.id=s.policy_id AND p.status='VALIDATED'
        RETURNING s.id::text
      `,
      [params.suggestionId, params.input.expected_version, params.actor.userId]
    );
    if (!updated.rows[0]) {
      throw new HttpError(
        409,
        "REMINDER_NOT_APPROVABLE",
        "La relance a changé, n'est plus proposée ou sa politique n'est plus active."
      );
    }
    await insertEvent({
      queryer: client,
      suggestionId: params.suggestionId,
      eventType: "SUGGESTION_APPROVED",
      fromStatus: "SUGGESTED",
      toStatus: "APPROVED",
      actorUserId: params.actor.userId,
    });
    const suggestion = await fetchSuggestion(client, params.suggestionId);
    if (!suggestion) throw new Error("Approved reminder disappeared");
    const result = { suggestion, idempotent_replay: false };
    await saveCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      requestHash: command.requestHash,
      commandType: "REMINDER_APPROVE",
      suggestionId: params.suggestionId,
      result,
    });
    await audit({
      client,
      actor: params.actor,
      action: "facturation.reminder_approved",
      entityType: "adv_reminder_suggestion",
      entityId: params.suggestionId,
      details: { facture_id: suggestion.facture_id, cadence_step_days: suggestion.cadence_step_days },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoRetryReminder(params: {
  suggestionId: string;
  input: RetryReminderDTO;
  actor: FinanceActorContext;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = await acquireCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      commandType: "REMINDER_RETRY",
      payload: { suggestionId: params.suggestionId, expectedVersion: params.input.expected_version },
    });
    if (command.replay) {
      await client.query("COMMIT");
      return { ...command.replay, idempotent_replay: true };
    }
    const updated = await client.query<{ previous_status: string }>(
      `
        UPDATE public.adv_reminder_suggestions s
        SET status='APPROVED',next_attempt_at=now(),last_error_code=NULL,last_error_message=NULL,
            row_version=row_version+1,updated_at=now()
        FROM public.adv_reminder_policies p
        WHERE s.id=$1::uuid AND s.row_version=$2
          AND s.status IN ('FAILED_RETRYABLE','FAILED_FINAL')
          AND p.id=s.policy_id AND p.status='VALIDATED'
        RETURNING CASE WHEN s.attempt_count >= 0 THEN 'FAILED' ELSE 'FAILED' END AS previous_status
      `,
      [params.suggestionId, params.input.expected_version]
    );
    if (!updated.rows[0]) {
      throw new HttpError(409, "REMINDER_NOT_RETRYABLE", "La relance ne peut pas être reprise dans son état actuel.");
    }
    await insertEvent({
      queryer: client,
      suggestionId: params.suggestionId,
      eventType: "SUGGESTION_RESUMED",
      fromStatus: null,
      toStatus: "APPROVED",
      actorUserId: params.actor.userId,
    });
    const suggestion = await fetchSuggestion(client, params.suggestionId);
    if (!suggestion) throw new Error("Retried reminder disappeared");
    const result = { suggestion, idempotent_replay: false };
    await saveCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      requestHash: command.requestHash,
      commandType: "REMINDER_RETRY",
      suggestionId: params.suggestionId,
      result,
    });
    await audit({
      client,
      actor: params.actor,
      action: "facturation.reminder_resumed",
      entityType: "adv_reminder_suggestion",
      entityId: params.suggestionId,
      details: { attempt_count: suggestion.attempt_count },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoCancelReminder(params: {
  suggestionId: string;
  input: CancelReminderDTO;
  actor: FinanceActorContext;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = await acquireCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      commandType: "REMINDER_CANCEL",
      payload: { suggestionId: params.suggestionId, ...params.input },
    });
    if (command.replay) {
      await client.query("COMMIT");
      return { ...command.replay, idempotent_replay: true };
    }
    const previous = await client.query<{ status: string }>(
      `SELECT status FROM public.adv_reminder_suggestions WHERE id=$1::uuid FOR UPDATE`,
      [params.suggestionId]
    );
    if (!previous.rows[0]) throw new HttpError(404, "REMINDER_NOT_FOUND", "Relance introuvable.");
    const updated = await client.query(
      `
        UPDATE public.adv_reminder_suggestions
        SET status='CANCELLED',cancelled_at=now(),cancellation_reason=$3,
            claim_token=NULL,claimed_at=NULL,claimed_by=NULL,row_version=row_version+1,updated_at=now()
        WHERE id=$1::uuid AND row_version=$2
          AND status IN ('SUGGESTED','BLOCKED','APPROVED','FAILED_RETRYABLE','FAILED_FINAL')
        RETURNING id
      `,
      [params.suggestionId, params.input.expected_version, params.input.reason]
    );
    if (!updated.rows[0]) throw new HttpError(409, "REMINDER_NOT_CANCELLABLE", "La relance a changé ou ne peut plus être annulée.");
    await insertEvent({
      queryer: client,
      suggestionId: params.suggestionId,
      eventType: "SUGGESTION_CANCELLED_MANUALLY",
      fromStatus: previous.rows[0].status,
      toStatus: "CANCELLED",
      actorUserId: params.actor.userId,
      details: { reason: params.input.reason },
    });
    const suggestion = await fetchSuggestion(client, params.suggestionId);
    if (!suggestion) throw new Error("Cancelled reminder disappeared");
    const result = { suggestion, idempotent_replay: false };
    await saveCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      requestHash: command.requestHash,
      commandType: "REMINDER_CANCEL",
      suggestionId: params.suggestionId,
      result,
    });
    await audit({
      client,
      actor: params.actor,
      action: "facturation.reminder_cancelled",
      entityType: "adv_reminder_suggestion",
      entityId: params.suggestionId,
      details: { reason: params.input.reason },
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function claimReminder(params: {
  suggestionId?: string;
  expectedVersion?: number;
  actor: FinanceActorContext | null;
  command?: { idempotencyKey: string; commandType: string };
}): Promise<{ claim: ReminderClaim | null; terminal: Record<string, unknown> | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let commandHash: string | null = null;
    if (params.actor && params.command) {
      const acquired = await acquireCommand({
        client,
        actorUserId: params.actor.userId,
        idempotencyKey: params.command.idempotencyKey,
        commandType: params.command.commandType,
        payload: { suggestionId: params.suggestionId, expectedVersion: params.expectedVersion },
      });
      if (acquired.replay) {
        await client.query("COMMIT");
        return { claim: null, terminal: { ...acquired.replay, idempotent_replay: true } };
      }
      commandHash = acquired.requestHash;
    }
    const where = params.suggestionId
      ? `s.id=$1::uuid AND s.row_version=$2 AND s.status IN ('APPROVED','FAILED_RETRYABLE')`
      : `(s.status IN ('APPROVED','FAILED_RETRYABLE') OR (s.status='CLAIMED' AND s.claimed_at<now()-interval '10 minutes'))
         AND COALESCE(s.next_attempt_at,now())<=now()`;
    const values = params.suggestionId ? [params.suggestionId, params.expectedVersion] : [];
    const locked = await client.query(
      `
        SELECT s.*,p.retry_delays_minutes,p.status AS policy_status,
          COALESCE(selected_contact.email,primary_contact.email,c.email) AS recipient_email,
          COALESCE(pref.opted_out,false) AS opted_out,
          COALESCE(pref.restricted_processing,false) AS restricted_processing,
          COALESCE(pref.channel,'EMAIL') AS live_channel,
          f.document_status,f.statut AS facture_status,f.settlement_status
        FROM public.adv_reminder_suggestions s
        JOIN public.adv_reminder_policies p ON p.id=s.policy_id
        JOIN public.facture f ON f.id=s.facture_id
        JOIN public.clients c ON c.client_id=s.client_id
        LEFT JOIN public.adv_reminder_client_preferences pref ON pref.client_id=s.client_id
        LEFT JOIN public.contacts selected_contact ON selected_contact.contact_id=COALESCE(pref.recipient_contact_id,s.recipient_contact_id)
          AND selected_contact.client_id=s.client_id AND selected_contact.archived_at IS NULL
        LEFT JOIN public.contacts primary_contact ON primary_contact.contact_id=c.contact_id
          AND primary_contact.client_id=s.client_id AND primary_contact.archived_at IS NULL
        WHERE ${where}
        ORDER BY s.next_attempt_at NULLS FIRST,s.created_at,s.id
        FOR UPDATE OF s SKIP LOCKED
        LIMIT 1
      `,
      values
    );
    const row = locked.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      if (params.suggestionId) {
        throw new HttpError(409, "REMINDER_NOT_SENDABLE", "La relance a changé ou n'est pas prête à être envoyée.");
      }
      await client.query("COMMIT");
      return { claim: null, terminal: null };
    }
    const invalidReason =
      row.policy_status !== "VALIDATED" ? "POLICY_RETIRED"
        : row.opted_out === true ? "CLIENT_OPT_OUT"
          : row.restricted_processing === true ? "PROCESSING_RESTRICTED"
            : row.live_channel === "NONE" ? "CHANNEL_DISABLED"
              : row.document_status !== "ISSUED" && !["ISSUED", "PARTIALLY_PAID", "emis", "emise", "envoyee", "partielle"].includes(String(row.facture_status))
                ? "INVOICE_NOT_ISSUED"
                : row.settlement_status === "PAID" || row.facture_status === "PAID" || row.facture_status === "payee"
                  ? "INVOICE_SETTLED"
                  : !String(row.recipient_email ?? "").trim() ? "RECIPIENT_MISSING"
                    : null;
    if (invalidReason) {
      const targetStatus = invalidReason === "RECIPIENT_MISSING" ? "BLOCKED" : "CANCELLED";
      await client.query(
        `
          UPDATE public.adv_reminder_suggestions
          SET status=$2,cancellation_reason=$3,cancelled_at=CASE WHEN $2='CANCELLED' THEN now() ELSE NULL END,
              claim_token=NULL,claimed_at=NULL,claimed_by=NULL,row_version=row_version+1,updated_at=now()
          WHERE id=$1::uuid
        `,
        [String(row.id), targetStatus, invalidReason]
      );
      await insertEvent({
        queryer: client,
        suggestionId: String(row.id),
        eventType: "SUGGESTION_RECHECK_BLOCKED",
        fromStatus: String(row.status),
        toStatus: targetStatus,
        actorUserId: params.actor?.userId ?? null,
        details: { reason_code: invalidReason },
      });
      const suggestion = await fetchSuggestion(client, String(row.id));
      const result = { suggestion, idempotent_replay: false };
      if (params.actor && params.command && commandHash) {
        await saveCommand({
          client,
          actorUserId: params.actor.userId,
          idempotencyKey: params.command.idempotencyKey,
          requestHash: commandHash,
          commandType: params.command.commandType,
          suggestionId: String(row.id),
          result,
        });
      }
      await client.query("COMMIT");
      return { claim: null, terminal: result };
    }
    if (!params.suggestionId && row.status === "FAILED_RETRYABLE" && new Date(String(row.next_attempt_at)).getTime() > Date.now()) {
      await client.query("COMMIT");
      return { claim: null, terminal: null };
    }
    const claimToken = crypto.randomUUID();
    const updated = await client.query<{ attempt_count: number }>(
      `
        UPDATE public.adv_reminder_suggestions
        SET status='CLAIMED',claim_token=$2::uuid,claimed_at=now(),claimed_by=$3,
            attempt_count=attempt_count+1,row_version=row_version+1,updated_at=now()
        WHERE id=$1::uuid
        RETURNING attempt_count
      `,
      [String(row.id), claimToken, params.actor?.userId ?? null]
    );
    await insertEvent({
      queryer: client,
      suggestionId: String(row.id),
      eventType: "DELIVERY_CLAIMED",
      fromStatus: String(row.status),
      toStatus: "CLAIMED",
      actorUserId: params.actor?.userId ?? null,
      details: { attempt_no: updated.rows[0].attempt_count },
    });
    await client.query("COMMIT");
    return {
      terminal: null,
      claim: {
        suggestionId: String(row.id),
        claimToken,
        attemptNo: updated.rows[0].attempt_count,
        actor: params.actor,
        command:
          params.actor && params.command && commandHash
            ? {
                idempotencyKey: params.command.idempotencyKey,
                requestHash: commandHash,
                commandType: params.command.commandType,
              }
            : null,
        message: {
          idempotencyKey: String(row.idempotency_key),
          recipient: String(row.recipient_email),
          subject: String(row.subject_snapshot),
          body: String(row.body_snapshot),
          attachmentDocumentId:
            row.attachment_document_id == null ? null : String(row.attachment_document_id),
        },
        retryDelaysMinutes: (row.retry_delays_minutes as number[] | null) ?? [],
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export const repoClaimReminderForManualSend = (params: {
  suggestionId: string;
  expectedVersion: number;
  actor: FinanceActorContext;
  idempotencyKey: string;
}) => claimReminder({
  suggestionId: params.suggestionId,
  expectedVersion: params.expectedVersion,
  actor: params.actor,
  command: { idempotencyKey: params.idempotencyKey, commandType: "REMINDER_SEND" },
});

export const repoClaimNextReminder = () => claimReminder({ actor: null });

export async function repoCompleteReminderDelivery(params: {
  claim: ReminderClaim;
  outcome:
    | { ok: true; provider: "sandbox"; providerMessageId: string; recipientHash: string }
    | { ok: false; code: string; retryable: boolean; safeMessage: string };
}): Promise<ReminderSuggestion> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ status: string; claim_token: string }>(
      `SELECT status,claim_token::text FROM public.adv_reminder_suggestions WHERE id=$1::uuid FOR UPDATE`,
      [params.claim.suggestionId]
    );
    const row = locked.rows[0];
    if (!row || row.status !== "CLAIMED" || row.claim_token !== params.claim.claimToken) {
      throw new HttpError(409, "REMINDER_CLAIM_LOST", "La tentative de relance n'est plus propriétaire du traitement.");
    }
    let targetStatus: "SENT" | "FAILED_RETRYABLE" | "FAILED_FINAL";
    let retryAt: Date | null = null;
    if (params.outcome.ok) {
      targetStatus = "SENT";
    } else {
      const delay = params.outcome.retryable
        ? retryDelayMinutes(params.claim.retryDelaysMinutes, params.claim.attemptNo)
        : null;
      targetStatus = delay == null ? "FAILED_FINAL" : "FAILED_RETRYABLE";
      retryAt = delay == null ? null : new Date(Date.now() + delay * 60_000);
    }
    await client.query(
      `
        UPDATE public.adv_reminder_suggestions
        SET status=$3,claim_token=NULL,claimed_at=NULL,claimed_by=NULL,
            sent_at=CASE WHEN $3='SENT' THEN now() ELSE sent_at END,
            provider_message_id=CASE WHEN $3='SENT' THEN $4 ELSE provider_message_id END,
            last_error_code=CASE WHEN $3='SENT' THEN NULL ELSE $5 END,
            last_error_message=CASE WHEN $3='SENT' THEN NULL ELSE $6 END,
            next_attempt_at=$7,row_version=row_version+1,updated_at=now()
        WHERE id=$1::uuid AND claim_token=$2::uuid
      `,
      [
        params.claim.suggestionId,
        params.claim.claimToken,
        targetStatus,
        params.outcome.ok ? params.outcome.providerMessageId : null,
        params.outcome.ok ? null : params.outcome.code,
        params.outcome.ok ? null : params.outcome.safeMessage,
        retryAt?.toISOString() ?? null,
      ]
    );
    await client.query(
      `
        INSERT INTO public.adv_reminder_attempts (
          suggestion_id,attempt_no,status,provider,provider_message_id,error_code,retryable,recipient_hash,actor_user_id
        ) VALUES ($1::uuid,$2,$3,'sandbox',$4,$5,$6,$7,$8)
      `,
      [
        params.claim.suggestionId,
        params.claim.attemptNo,
        params.outcome.ok ? "SENT" : "FAILED",
        params.outcome.ok ? params.outcome.providerMessageId : null,
        params.outcome.ok ? null : params.outcome.code,
        params.outcome.ok ? false : params.outcome.retryable,
        params.outcome.ok ? params.outcome.recipientHash : null,
        params.claim.actor?.userId ?? null,
      ]
    );
    await insertEvent({
      queryer: client,
      suggestionId: params.claim.suggestionId,
      eventType: params.outcome.ok ? "DELIVERY_SENT" : "DELIVERY_FAILED",
      fromStatus: "CLAIMED",
      toStatus: targetStatus,
      actorUserId: params.claim.actor?.userId ?? null,
      details: {
        attempt_no: params.claim.attemptNo,
        provider: "sandbox",
        error_code: params.outcome.ok ? null : params.outcome.code,
        retry_at: retryAt?.toISOString() ?? null,
      },
    });
    const suggestion = await fetchSuggestion(client, params.claim.suggestionId);
    if (!suggestion) throw new Error("Completed reminder disappeared");
    const result = { suggestion, idempotent_replay: false };
    if (params.claim.actor && params.claim.command) {
      await saveCommand({
        client,
        actorUserId: params.claim.actor.userId,
        idempotencyKey: params.claim.command.idempotencyKey,
        requestHash: params.claim.command.requestHash,
        commandType: params.claim.command.commandType,
        suggestionId: params.claim.suggestionId,
        result,
      });
      await audit({
        client,
        actor: params.claim.actor,
        action: params.outcome.ok ? "facturation.reminder_sandbox_sent" : "facturation.reminder_failed",
        entityType: "adv_reminder_suggestion",
        entityId: params.claim.suggestionId,
        details: {
          attempt_no: params.claim.attemptNo,
          status: targetStatus,
          error_code: params.outcome.ok ? null : params.outcome.code,
        },
      });
    }
    await client.query("COMMIT");
    return suggestion;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoListReminderHistory(params: {
  factureId?: number;
  clientId?: string;
  limit: number;
}): Promise<ReminderHistoryEvent[]> {
  const where = params.factureId ? "s.facture_id=$1" : "s.client_id=$1::uuid";
  const value = params.factureId ?? params.clientId;
  const result = await pool.query(
    `
      SELECT e.id::text,e.suggestion_id::text,s.facture_id,s.client_id::text AS client_id,
        e.event_type,e.from_status,e.to_status,e.actor_user_id,e.details,e.created_at::text
      FROM public.adv_reminder_events e
      JOIN public.adv_reminder_suggestions s ON s.id=e.suggestion_id
      WHERE ${where}
      ORDER BY e.created_at DESC,e.id DESC
      LIMIT $2
    `,
    [value, params.limit]
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    suggestion_id: String(row.suggestion_id),
    facture_id: Number(row.facture_id),
    client_id: String(row.client_id),
    event_type: String(row.event_type),
    from_status: row.from_status ?? null,
    to_status: row.to_status,
    actor_user_id: row.actor_user_id == null ? null : Number(row.actor_user_id),
    details: (row.details as Record<string, unknown> | null) ?? {},
    created_at: String(row.created_at),
  }));
}

export async function repoUpsertReminderClientPreference(params: {
  clientId: string;
  input: ReminderClientPreferenceDTO;
  actor: FinanceActorContext;
}): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const command = await acquireCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      commandType: "REMINDER_CLIENT_PREFERENCE",
      payload: { clientId: params.clientId, ...params.input },
    });
    if (command.replay) {
      await client.query("COMMIT");
      return { ...command.replay, idempotent_replay: true };
    }
    const clientExists = await client.query(`SELECT 1 FROM public.clients WHERE client_id=$1::uuid`, [params.clientId]);
    if (!clientExists.rows[0]) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
    if (params.input.recipient_contact_id) {
      const contact = await client.query(
        `SELECT 1 FROM public.contacts WHERE contact_id=$1::uuid AND client_id=$2::uuid AND archived_at IS NULL`,
        [params.input.recipient_contact_id, params.clientId]
      );
      if (!contact.rows[0]) {
        throw new HttpError(422, "REMINDER_CONTACT_INVALID", "Le contact de relance n'appartient pas au client ou est archivé.");
      }
    }
    const existing = await client.query<{ row_version: number }>(
      `SELECT row_version FROM public.adv_reminder_client_preferences WHERE client_id=$1::uuid FOR UPDATE`,
      [params.clientId]
    );
    const actualVersion = existing.rows[0]?.row_version ?? 0;
    if (actualVersion !== params.input.expected_version) {
      throw new HttpError(409, "CONCURRENT_MODIFICATION", "Les préférences de relance ont changé.");
    }
    const result = await client.query(
      `
        INSERT INTO public.adv_reminder_client_preferences (
          client_id,channel,recipient_contact_id,opted_out,restricted_processing,lawful_basis,
          consent_granted,consent_version,consent_source,consent_recorded_at,created_by,updated_by,row_version
        ) VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9,
          CASE WHEN $7 IS NULL THEN NULL ELSE now() END,$10,$10,1)
        ON CONFLICT (client_id) DO UPDATE SET
          channel=EXCLUDED.channel,recipient_contact_id=EXCLUDED.recipient_contact_id,
          opted_out=EXCLUDED.opted_out,restricted_processing=EXCLUDED.restricted_processing,
          lawful_basis=EXCLUDED.lawful_basis,consent_granted=EXCLUDED.consent_granted,
          consent_version=EXCLUDED.consent_version,consent_source=EXCLUDED.consent_source,
          consent_recorded_at=EXCLUDED.consent_recorded_at,updated_by=EXCLUDED.updated_by,
          row_version=adv_reminder_client_preferences.row_version+1,updated_at=now()
        RETURNING client_id::text,channel,recipient_contact_id::text,opted_out,restricted_processing,
          lawful_basis,consent_granted,consent_version,consent_source,consent_recorded_at::text,row_version
      `,
      [
        params.clientId,
        params.input.channel,
        params.input.recipient_contact_id,
        params.input.opted_out,
        params.input.restricted_processing,
        params.input.lawful_basis,
        params.input.consent_granted,
        params.input.consent_version,
        params.input.consent_source,
        params.actor.userId,
      ]
    );
    if (params.input.opted_out || params.input.restricted_processing || params.input.channel === "NONE") {
      const cancelled = await client.query<{ id: string; previous_status: string }>(
        `
          WITH candidates AS (
            SELECT id,status AS previous_status FROM public.adv_reminder_suggestions
            WHERE client_id=$1::uuid AND status IN ('SUGGESTED','BLOCKED','APPROVED','FAILED_RETRYABLE','FAILED_FINAL')
            FOR UPDATE
          ), updated AS (
            UPDATE public.adv_reminder_suggestions s
            SET status='CANCELLED',cancelled_at=now(),cancellation_reason=$2,
                row_version=row_version+1,updated_at=now()
            FROM candidates c WHERE s.id=c.id
            RETURNING s.id::text,c.previous_status
          ) SELECT * FROM updated
        `,
        [
          params.clientId,
          params.input.opted_out
            ? "CLIENT_OPT_OUT"
            : params.input.restricted_processing
              ? "PROCESSING_RESTRICTED"
              : "CHANNEL_DISABLED",
        ]
      );
      for (const row of cancelled.rows) {
        await insertEvent({
          queryer: client,
          suggestionId: row.id,
          eventType: "SUGGESTION_CANCELLED_BY_PREFERENCE",
          fromStatus: row.previous_status,
          toStatus: "CANCELLED",
          actorUserId: params.actor.userId,
        });
      }
    }
    const payload = { preference: result.rows[0], idempotent_replay: false };
    await saveCommand({
      client,
      actorUserId: params.actor.userId,
      idempotencyKey: params.input.idempotency_key,
      requestHash: command.requestHash,
      commandType: "REMINDER_CLIENT_PREFERENCE",
      result: payload,
    });
    await audit({
      client,
      actor: params.actor,
      action: "facturation.reminder_client_preference_updated",
      entityType: "client",
      entityId: params.clientId,
      details: {
        channel: params.input.channel,
        opted_out: params.input.opted_out,
        restricted_processing: params.input.restricted_processing,
        lawful_basis: params.input.lawful_basis,
      },
    });
    await client.query("COMMIT");
    return payload;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function repoGetReminderClientPreference(clientId: string): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `
      SELECT client_id::text,channel,recipient_contact_id::text,opted_out,restricted_processing,
        lawful_basis,consent_granted,consent_version,consent_source,consent_recorded_at::text,row_version
      FROM public.adv_reminder_client_preferences
      WHERE client_id=$1::uuid
    `,
    [clientId]
  );
  if (result.rows[0]) return result.rows[0];
  const exists = await pool.query(`SELECT 1 FROM public.clients WHERE client_id=$1::uuid`, [clientId]);
  if (!exists.rows[0]) throw new HttpError(404, "CLIENT_NOT_FOUND", "Client introuvable.");
  return {
    client_id: clientId,
    channel: "EMAIL",
    recipient_contact_id: null,
    opted_out: false,
    restricted_processing: false,
    lawful_basis: "LEGITIMATE_INTEREST",
    consent_granted: null,
    consent_version: null,
    consent_source: null,
    consent_recorded_at: null,
    row_version: 0,
  };
}
