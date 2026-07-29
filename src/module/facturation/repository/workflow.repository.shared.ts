import crypto from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { HttpError } from "../../../utils/httpError";
import {
  decideReceipt,
  financeRequestHash,
  normalizeIdempotencyKey,
} from "../domain/finance-policy";

export type FinanceActorContext = {
  userId: number;
  requestId: string;
  path: string;
};

export type DbQueryer = Pick<PoolClient, "query">;

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
  aggregateType: "FACTURE" | "AVOIR" | "PAIEMENT";
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
  aggregateType: "FACTURE" | "AVOIR" | "PAIEMENT";
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
  aggregateType: "FACTURE" | "AVOIR" | "PAIEMENT";
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
  const periodKey = params.issueDate.slice(0, 4);
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
