import crypto from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { HttpError } from "../../../utils/httpError";
import {
  decideReceipt,
  financeRequestHash,
  normalizeIdempotencyKey,
} from "../domain/finance-policy";
import { assertFinancialCutoverEmissionAllowedTx } from "./financial-cutover-guard";

export type FinanceActorContext = {
  userId: number;
  requestId: string;
  path: string;
};

export type DbQueryer = Pick<PoolClient, "query">;
export type FinanceAggregateType = "FACTURE" | "AVOIR" | "PAIEMENT" | "PROFORMA";

export async function acquireFinanceIdempotency(params: {
  client: PoolClient;
  actor: FinanceActorContext;
  idempotencyKeyRaw: string | null | undefined;
  commandType: string;
  requestPayload: unknown;
}): Promise<{
  idempotencyKey: string;
  requestHash: string;
  replay: Record<string, unknown> | null;
}> {
  const idempotencyKey = normalizeIdempotencyKey(params.idempotencyKeyRaw);
  const requestHash = financeRequestHash(params.commandType, params.requestPayload);
  await params.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `finance:${params.actor.userId}:${idempotencyKey}`,
  ]);
  const existing = await params.client.query<{
    request_hash: string;
    result_payload: Record<string, unknown>;
  }>(
    `
      SELECT request_hash, result_payload
      FROM public.finance_command_receipts
      WHERE actor_user_id = $1
        AND idempotency_key = $2
      LIMIT 1
    `,
    [params.actor.userId, idempotencyKey]
  );
  const receipt = existing.rows[0] ?? null;
  const decision = decideReceipt(receipt?.request_hash, requestHash);
  if (decision === "CONFLICT") {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Cette Idempotency-Key a déjà été utilisée avec un autre contenu."
    );
  }
  if (decision !== "REPLAY") {
    // Match BL read guards before locking an invoice, credit note or payment.
    // The SQL epoch also protects stale SERIALIZABLE shipment snapshots.
    await params.client.query("SELECT public.fn_lock_delivery_prepayment_write_1268()");
  }
  return {
    idempotencyKey,
    requestHash,
    replay: decision === "REPLAY" ? receipt?.result_payload ?? null : null,
  };
}

export async function saveFinanceReceipt(params: {
  client: PoolClient;
  actor: FinanceActorContext;
  idempotencyKey: string;
  requestHash: string;
  commandType: string;
  aggregateType: FinanceAggregateType;
  aggregateId: string;
  requestPayload: unknown;
  resultPayload: unknown;
  correlationId: string;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO public.finance_command_receipts (
        actor_user_id,
        idempotency_key,
        request_hash,
        command_type,
        aggregate_type,
        aggregate_id,
        request_payload,
        result_payload,
        correlation_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::uuid)
    `,
    [
      params.actor.userId,
      params.idempotencyKey,
      params.requestHash,
      params.commandType,
      params.aggregateType,
      params.aggregateId,
      JSON.stringify(params.requestPayload),
      JSON.stringify(params.resultPayload),
      params.correlationId,
    ]
  );
}

export async function insertFinanceEvent(params: {
  client: PoolClient;
  aggregateType: FinanceAggregateType;
  aggregateId: string;
  eventType: string;
  oldValues?: unknown;
  newValues?: unknown;
  actor: FinanceActorContext;
  correlationId: string;
  idempotencyKey?: string | null;
  ruleCode?: string | null;
  reason?: string | null;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO public.finance_event_log (
        aggregate_type,
        aggregate_id,
        event_type,
        old_values,
        new_values,
        actor_user_id,
        correlation_id,
        idempotency_key,
        rule_code,
        reason,
        request_id
      )
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::uuid,$8,$9,$10,$11)
    `,
    [
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      params.oldValues === undefined ? null : JSON.stringify(params.oldValues),
      params.newValues === undefined ? null : JSON.stringify(params.newValues),
      params.actor.userId,
      params.correlationId,
      params.idempotencyKey ?? null,
      params.ruleCode ?? null,
      params.reason ?? null,
      params.actor.requestId,
    ]
  );
}

export async function insertFinanceOutbox(params: {
  client: PoolClient;
  eventKey: string;
  aggregateType: FinanceAggregateType;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  correlationId: string;
}): Promise<void> {
  await params.client.query(
    `
      INSERT INTO public.erp_outbox_events (
        event_key,
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        correlation_id
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid)
      ON CONFLICT (event_key) DO NOTHING
    `,
    [
      params.eventKey,
      params.aggregateType,
      params.aggregateId,
      params.eventType,
      JSON.stringify(params.payload),
      params.correlationId,
    ]
  );
}

export async function insertGlobalFinanceAudit(params: {
  client: PoolClient;
  actor: FinanceActorContext;
  action: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
}): Promise<void> {
  await repoInsertAuditLog({
    user_id: params.actor.userId,
    body: {
      event_type: "ACTION",
      action: params.action,
      page_key: "facturation",
      entity_type: params.entityType,
      entity_id: params.entityId,
      path: params.actor.path,
      client_session_id: null,
      details: {
        ...params.details,
        request_id: params.actor.requestId,
      },
    },
    ip: null,
    user_agent: null,
    device_type: null,
    os: null,
    browser: null,
    tx: params.client,
  });
}

export async function nextLegacyId(client: PoolClient, sequenceName: string): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(sequenceName)) throw new Error("Invalid sequence name");
  const result = await client.query<{ id: string }>(
    `SELECT nextval('public.${sequenceName}')::bigint::text AS id`
  );
  const raw = result.rows[0]?.id;
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`Failed to allocate ${sequenceName}`);
  const id = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Unsafe legacy identifier allocated by ${sequenceName}`);
  }
  return id;
}

export async function allocateLegalNumber(params: {
  client: PoolClient;
  documentType: "FACTURE" | "AVOIR";
  entityCode: string;
  issueDate: string;
}): Promise<{ legalNumber: string; periodKey: string; sequenceValue: number }> {
  // The shared row lock makes the transition to PREPARING wait for an
  // allocation already in progress, and vice versa.
  const financialCutover = await assertFinancialCutoverEmissionAllowedTx(params.client);
  const periodKey = params.issueDate.slice(0, 4);
  const commonSeries = await nextActiveCutoverFinanceSharedSeries({
    client: params.client,
    documentType: params.documentType,
    entityCode: params.entityCode,
    periodKey,
  });
  if (commonSeries) return commonSeries;
  if (financialCutover.phase === "ACTIVE") {
    throw new HttpError(
      409,
      "FINANCIAL_CUTOVER_SHARED_SERIES_PERIOD_REQUIRED",
      "La série commune factures, acomptes et avoirs doit être configurée pour cette période avant toute émission."
    );
  }
  const sequence = await params.client.query<{
    id: string;
    prefix: string;
    next_value: string;
    padding: number;
  }>(
    `
      SELECT id::text AS id, prefix, next_value::text AS next_value, padding
      FROM public.finance_legal_sequences
      WHERE document_type = $1
        AND entity_code = $2
        AND period_key = $3
        AND active = TRUE
      FOR UPDATE
    `,
    [params.documentType, params.entityCode, periodKey]
  );
  const row = sequence.rows[0] ?? null;
  if (!row) {
    throw new HttpError(
      503,
      "FINANCE_LEGAL_SEQUENCE_NOT_CONFIGURED",
      "Aucune séquence Finance validée n'est active pour cette entité et cette période."
    );
  }
  const sequenceValue = Number.parseInt(row.next_value, 10);
  if (!Number.isSafeInteger(sequenceValue) || sequenceValue <= 0) {
    throw new Error("Invalid finance legal sequence value");
  }
  const legalNumber = `${row.prefix}${String(sequenceValue).padStart(row.padding, "0")}`;
  await params.client.query(
    `
      UPDATE public.finance_legal_sequences
      SET next_value = next_value + 1,
          updated_at = now()
      WHERE id = $1::uuid
    `,
    [row.id]
  );
  return { legalNumber, periodKey, sequenceValue };
}

type CutoverFinanceSharedSeriesRow = {
  allocated_value: string;
  facture_prefix: string;
  avoir_prefix: string;
  padding: number;
};

/**
 * Reads the cutover-only fiscal series when it has been explicitly activated.
 * Before activation (and on installations that do not have the additive patch),
 * the existing FACTURE/AVOIR behavior remains authoritative.
 */
async function nextActiveCutoverFinanceSharedSeries(params: {
  client: PoolClient;
  documentType: "FACTURE" | "AVOIR";
  entityCode: string;
  periodKey: string;
}): Promise<{ legalNumber: string; periodKey: string; sequenceValue: number } | null> {
  // Never probe a missing relation with UPDATE inside an issuance transaction:
  // 42P01 would abort that transaction before the legacy allocator can run.
  const relation = await params.client.query<{ relation: string | null }>(
    "SELECT to_regclass($1)::text AS relation",
    ["public.cutover_finance_shared_sequences"]
  );
  if (!relation.rows[0]?.relation) return null;
  const allocated = await params.client.query<CutoverFinanceSharedSeriesRow>(
    `
      UPDATE public.cutover_finance_shared_sequences
      SET next_value = next_value + 1,
          updated_at = now()
      WHERE entity_code = $1
        AND period_key = $2
        AND active = TRUE
      RETURNING (next_value - 1)::text AS allocated_value,
                facture_prefix,
                avoir_prefix,
                padding
    `,
    [params.entityCode, params.periodKey]
  );
  const row = allocated.rows[0];
  if (!row) return null;
  if (!/^\d+$/.test(row.allocated_value)) throw new Error("Invalid configured common finance sequence value");
  const sequenceValue = Number.parseInt(row.allocated_value, 10);
  if (!Number.isSafeInteger(sequenceValue) || sequenceValue <= 0 || !Number.isInteger(row.padding) || row.padding < 1 || row.padding > 12) {
    throw new Error("Invalid configured common finance sequence value");
  }
  const prefix = params.documentType === "FACTURE" ? row.facture_prefix : row.avoir_prefix;
  if (!prefix) throw new Error("Invalid configured common finance sequence prefix");
  return {
    legalNumber: `${prefix}${String(sequenceValue).padStart(row.padding, "0")}`,
    periodKey: params.periodKey,
    sequenceValue,
  };
}

/**
 * Transactional helper for the future SuperAdmin/MFA cutover route. It never
 * infers consent from legacy FACTURE/AVOIR rows: those rows must be reviewed
 * outside this helper before the common legal sequence can be activated.
 */
export async function activateCutoverFinanceSharedSeriesTx(params: {
  client: PoolClient;
  entityCode: string;
  periodKey: string;
  nextValue: number;
  facturePrefix: string;
  avoirPrefix: string;
  padding: number;
  actorId: number;
  evidenceReference: string;
}): Promise<{ entityCode: string; periodKey: string; nextValue: number }> {
  if (!/^[0-9]{4}$/.test(params.periodKey)) throw new Error("Invalid cutover finance period");
  if (!Number.isSafeInteger(params.nextValue) || params.nextValue <= 0) throw new Error("Invalid cutover finance next value");
  if (!Number.isInteger(params.padding) || params.padding < 1 || params.padding > 12) throw new Error("Invalid cutover finance padding");
  if (!Number.isSafeInteger(params.actorId) || params.actorId <= 0) throw new Error("Invalid cutover finance activation actor");
  if (!/^[A-Za-z0-9._/-]{1,60}$/.test(params.facturePrefix) || !/^[A-Za-z0-9._/-]{1,60}$/.test(params.avoirPrefix)) {
    throw new Error("Invalid cutover finance prefix");
  }
  if (!params.evidenceReference.trim() || params.evidenceReference.trim().length > 200) {
    throw new Error("Invalid cutover finance evidence reference");
  }

  const legacy = await params.client.query<{ document_type: string }>(
    `SELECT document_type
       FROM public.finance_legal_sequences
      WHERE entity_code = $1
        AND period_key = $2
        AND active = TRUE
      FOR UPDATE`,
    [params.entityCode, params.periodKey]
  );
  if (legacy.rows.length) {
    throw new HttpError(
      409,
      "CUTOVER_FINANCE_LEGACY_SEQUENCE_REVIEW_REQUIRED",
      "Des séquences Finance existantes doivent être vérifiées avant l'activation de la série commune."
    );
  }

  const existing = await params.client.query<{ active: boolean; next_value: string }>(
    `SELECT active, next_value::text AS next_value
       FROM public.cutover_finance_shared_sequences
      WHERE entity_code = $1 AND period_key = $2
      FOR UPDATE`,
    [params.entityCode, params.periodKey]
  );
  if (existing.rows[0]?.active) {
    throw new HttpError(409, "CUTOVER_FINANCE_SHARED_SERIES_ALREADY_ACTIVE", "La série Finance commune est déjà active et ne peut pas être réinitialisée.");
  }
  await params.client.query(
    `INSERT INTO public.cutover_finance_shared_sequences
       (entity_code, period_key, next_value, facture_prefix, avoir_prefix, padding, active, activated_at, activated_by, activation_evidence_reference, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,now(),$7,$8,now())
     ON CONFLICT (entity_code, period_key) DO UPDATE
       SET next_value = EXCLUDED.next_value,
           facture_prefix = EXCLUDED.facture_prefix,
           avoir_prefix = EXCLUDED.avoir_prefix,
           padding = EXCLUDED.padding,
           active = TRUE,
           activated_at = EXCLUDED.activated_at,
           activated_by = EXCLUDED.activated_by,
           activation_evidence_reference = EXCLUDED.activation_evidence_reference,
           updated_at = now()
       WHERE public.cutover_finance_shared_sequences.active = FALSE`,
    [params.entityCode, params.periodKey, params.nextValue, params.facturePrefix, params.avoirPrefix, params.padding, params.actorId, params.evidenceReference.trim()]
  );
  return { entityCode: params.entityCode, periodKey: params.periodKey, nextValue: params.nextValue };
}

/**
 * Instantane de l'entite emettrice, mentions legales **en vigueur a la date donnee**.
 *
 * Partage par la facture et l'avoir : les deux sont des pieces fiscales et doivent porter
 * exactement les memes mentions obligatoires, resolues selon la meme regle.
 *
 * La date est celle de l'**emission** du document, jamais « aujourd'hui » : c'est elle qui
 * determine quelle version de `finance_legal_mentions` fait foi. Le resultat est destine a
 * etre fige tel quel dans `issuer_snapshot`, qui devient alors autoportant — un document
 * retrouve dans dix ans se relit sans la base.
 *
 * Renvoie `null` quand l'entite est inconnue ; l'appelant decide si c'est une erreur.
 */
export async function issuerSnapshotAt(
  queryer: DbQueryer,
  entityCode: string,
  at: string
): Promise<Record<string, unknown> | null> {
  const result = await queryer.query<{ snapshot: Record<string, unknown> | null }>(
    `
      SELECT COALESCE(public.fn_finance_issuer_snapshot(f.biller_id, $2::date), '{}'::jsonb)
             || jsonb_build_object('entity_code', $1::text) AS snapshot
      FROM public.factureur f
      WHERE f.biller_id::text = $1
      LIMIT 1
    `,
    [entityCode, at]
  );
  const snapshot = result.rows[0]?.snapshot;
  return snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : null;
}

const REQUIRED_FINANCE_LEGAL_MENTION_KEYS = [
  "company_name",
  "legal_mentions_version",
  "legal_form",
  "share_capital",
  "share_capital_currency",
  "rcs_city",
  "rcs_number",
  "siret",
  "vat_number",
  "late_penalty_rate",
  "late_penalty_basis",
  "recovery_indemnity",
] as const;

function hasSnapshotValue(snapshot: Record<string, unknown>, key: string): boolean {
  const value = snapshot[key];
  return value !== null && value !== undefined && (typeof value !== "string" || value.trim().length > 0);
}

/**
 * Resolve the issuer snapshot required to issue a fiscal document.
 *
 * Drafts may remain readable while the legal reference data is being deployed. Issuance is
 * different: a missing legal version or mandatory field must fail before a legal number is
 * allocated, otherwise the server would knowingly create a non-compliant immutable document.
 */
export async function requireFinanceIssuerSnapshotAt(
  queryer: DbQueryer,
  entityCode: string,
  at: string
): Promise<Record<string, unknown>> {
  const snapshot = await issuerSnapshotAt(queryer, entityCode, at);
  if (!snapshot) {
    throw new HttpError(
      503,
      "FINANCE_ISSUER_NOT_CONFIGURED",
      "L'entité émettrice de la politique Finance est introuvable."
    );
  }

  const missing = REQUIRED_FINANCE_LEGAL_MENTION_KEYS.filter(
    (key) => !hasSnapshotValue(snapshot, key)
  );
  if (missing.length) {
    throw new HttpError(
      503,
      "FINANCE_LEGAL_MENTIONS_NOT_CONFIGURED",
      "Les mentions légales obligatoires de l'entité émettrice ne sont pas configurées pour la date d'émission.",
      { missing }
    );
  }
  return snapshot;
}

export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function mapNumericStrings<T extends QueryResultRow>(rows: T[]): T[] {
  return rows;
}
