import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  assertDeliveryPolicyContentMutable,
  assertDeliveryPolicyTransition,
  assertOptimisticVersion,
  normalizeQualityIdempotencyKey,
  qualityRequestHash,
  qualitySha256,
  type QualityDeliveryPolicyStatus,
} from "../domain/quality-policy";
import type { QualityActor } from "./quality-360.repository";
import type {
  CreateDeliveryPolicyBodyDTO,
  DeliveryPolicyTransitionBodyDTO,
  UpdateDeliveryPolicyBodyDTO,
} from "../validators/quality-360.validators";

export type DeliveryPolicyRow = {
  id: string;
  code: string;
  version: number;
  label: string;
  status: QualityDeliveryPolicyStatus;
  justification: string | null;
  rules: unknown;
  rules_sha256: string;
  signature_reference: string | null;
  document_reference: string | null;
  signed_by: number | null;
  signed_at: string | null;
  valid_from: string;
  valid_to: string | null;
  submitted_by: number | null;
  submitted_at: string | null;
  activated_by: number | null;
  activated_at: string | null;
  superseded_by_policy_id: string | null;
  superseded_at: string | null;
  revoked_by: number | null;
  revoked_at: string | null;
  revocation_reason: string | null;
  created_at: string;
  updated_at: string;
  created_by: number;
  updated_by: number;
};

const POLICY_COLUMNS = `
  id::text AS id, code, version, label, status, justification, rules, rules_sha256,
  signature_reference, document_reference, signed_by, signed_at::text AS signed_at,
  valid_from::text AS valid_from, valid_to::text AS valid_to,
  submitted_by, submitted_at::text AS submitted_at,
  activated_by, activated_at::text AS activated_at,
  superseded_by_policy_id::text AS superseded_by_policy_id,
  superseded_at::text AS superseded_at, revoked_by, revoked_at::text AS revoked_at,
  revocation_reason, created_at::text AS created_at, updated_at::text AS updated_at,
  created_by, updated_by
`;

async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function selectPolicy(
  client: Pick<PoolClient, "query">,
  id: string,
  forUpdate = false
): Promise<DeliveryPolicyRow | null> {
  const result = await client.query<DeliveryPolicyRow>(
    `SELECT ${POLICY_COLUMNS}
     FROM public.quality_delivery_release_policy
     WHERE id = $1::uuid
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function acquireCommand(params: {
  client: PoolClient;
  actor: QualityActor;
  idempotencyKeyRaw: string | null | undefined;
  commandType: string;
  payload: unknown;
}): Promise<{ key: string; hash: string; replayId: string | null }> {
  const key = normalizeQualityIdempotencyKey(params.idempotencyKeyRaw);
  const hash = qualityRequestHash(params.commandType, params.payload);
  await params.client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, $2::bigint))`,
    [key, params.actor.user_id]
  );
  const found = await params.client.query<{ request_hash: string; aggregate_id: string }>(
    `SELECT request_hash, aggregate_id
     FROM public.quality_command_receipts
     WHERE actor_user_id = $1 AND idempotency_key = $2`,
    [params.actor.user_id, key]
  );
  const existing = found.rows[0];
  if (existing && existing.request_hash !== hash) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette Idempotency-Key a deja ete utilisee avec un autre contenu.");
  }
  return { key, hash, replayId: existing?.aggregate_id ?? null };
}

async function appendEvent(params: {
  client: PoolClient;
  policy: DeliveryPolicyRow;
  eventType: string;
  fromStatus: string | null;
  reason: string | null;
  actor: QualityActor;
  idempotencyKey: string | null;
}): Promise<void> {
  const snapshot = { ...params.policy };
  await params.client.query(
    `INSERT INTO public.quality_delivery_release_policy_event (
       policy_id, event_type, from_status, to_status, reason, snapshot,
       snapshot_sha256, actor_user_id, idempotency_key
     ) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      params.policy.id,
      params.eventType,
      params.fromStatus,
      params.policy.status,
      params.reason,
      JSON.stringify(snapshot),
      qualitySha256(snapshot),
      params.actor.user_id,
      params.idempotencyKey,
    ]
  );
}

async function saveReceipt(params: {
  client: PoolClient;
  actor: QualityActor;
  key: string;
  hash: string;
  commandType: string;
  payload: unknown;
  policy: DeliveryPolicyRow;
}): Promise<void> {
  await params.client.query(
    `INSERT INTO public.quality_command_receipts (
       actor_user_id, idempotency_key, request_hash, command_type,
       aggregate_type, aggregate_id, request_payload, result_payload, correlation_id
     ) VALUES ($1, $2, $3, $4, 'POLICY', $5, $6::jsonb, $7::jsonb, gen_random_uuid())`,
    [
      params.actor.user_id,
      params.key,
      params.hash,
      params.commandType,
      params.policy.id,
      JSON.stringify(params.payload),
      JSON.stringify({ policy_id: params.policy.id, version: params.policy.version }),
    ]
  );
}

export async function repoListDeliveryPolicies(): Promise<DeliveryPolicyRow[]> {
  const result = await pool.query<DeliveryPolicyRow>(
    `SELECT ${POLICY_COLUMNS}
     FROM public.quality_delivery_release_policy
     ORDER BY version DESC, created_at DESC, id`
  );
  return result.rows;
}

export async function repoGetDeliveryPolicy(id: string): Promise<DeliveryPolicyRow | null> {
  return selectPolicy(pool, id);
}

export async function repoCreateDeliveryPolicy(params: {
  body: CreateDeliveryPolicyBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<DeliveryPolicyRow> {
  return transaction(async (client) => {
    const command = await acquireCommand({
      client,
      actor: params.actor,
      idempotencyKeyRaw: params.idempotencyKey,
      commandType: "quality.delivery-policy.create",
      payload: params.body,
    });
    if (command.replayId) {
      const replay = await selectPolicy(client, command.replayId);
      if (replay) return replay;
    }
    await client.query(`LOCK TABLE public.quality_delivery_release_policy IN SHARE ROW EXCLUSIVE MODE`);
    const versionResult = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(version), 0)::int + 1 AS version
       FROM public.quality_delivery_release_policy
       WHERE code = 'DELIVERY-RELEASE'`
    );
    const rulesHash = qualitySha256(params.body.rules);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.quality_delivery_release_policy (
         code, version, label, status, justification, rules, rules_sha256,
         valid_from, valid_to, created_by, updated_by
       ) VALUES ('DELIVERY-RELEASE', $1, $2, 'DRAFT', $3, $4::jsonb, $5,
                 $6::timestamptz, $7::timestamptz, $8, $8)
       RETURNING id::text AS id`,
      [
        versionResult.rows[0]!.version,
        params.body.label,
        params.body.justification,
        JSON.stringify(params.body.rules),
        rulesHash,
        params.body.valid_from,
        params.body.valid_to ?? null,
        params.actor.user_id,
      ]
    );
    const policy = (await selectPolicy(client, inserted.rows[0]!.id))!;
    await appendEvent({ client, policy, eventType: "CREATED", fromStatus: null, reason: params.body.justification, actor: params.actor, idempotencyKey: command.key });
    await saveReceipt({ client, actor: params.actor, key: command.key, hash: command.hash, commandType: "quality.delivery-policy.create", payload: params.body, policy });
    return policy;
  });
}

export async function repoUpdateDeliveryPolicy(params: {
  id: string;
  body: UpdateDeliveryPolicyBodyDTO;
  actor: QualityActor;
}): Promise<DeliveryPolicyRow | null> {
  return transaction(async (client) => {
    const before = await selectPolicy(client, params.id, true);
    if (!before) return null;
    assertDeliveryPolicyContentMutable(before.status);
    assertOptimisticVersion({ expectedUpdatedAt: params.body.expected_updated_at, currentUpdatedAt: before.updated_at });
    await client.query(
      `UPDATE public.quality_delivery_release_policy
       SET label = $2, justification = $3, rules = $4::jsonb, rules_sha256 = $5,
           valid_from = $6::timestamptz, valid_to = $7::timestamptz,
           updated_by = $8, updated_at = now()
       WHERE id = $1::uuid`,
      [params.id, params.body.label, params.body.justification, JSON.stringify(params.body.rules), qualitySha256(params.body.rules), params.body.valid_from, params.body.valid_to ?? null, params.actor.user_id]
    );
    const policy = (await selectPolicy(client, params.id))!;
    await appendEvent({ client, policy, eventType: "UPDATED", fromStatus: before.status, reason: params.body.justification, actor: params.actor, idempotencyKey: null });
    return policy;
  });
}

export async function repoReviseDeliveryPolicy(params: {
  id: string;
  revisionReason: string;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<DeliveryPolicyRow | null> {
  const source = await repoGetDeliveryPolicy(params.id);
  if (!source) return null;
  return repoCreateDeliveryPolicy({
    body: {
      label: source.label,
      justification: params.revisionReason,
      valid_from: source.valid_from,
      valid_to: source.valid_to,
      rules: source.rules as CreateDeliveryPolicyBodyDTO["rules"],
    },
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
  });
}

export async function repoTransitionDeliveryPolicy(params: {
  id: string;
  body: DeliveryPolicyTransitionBodyDTO;
  actor: QualityActor;
  idempotencyKey: string | null | undefined;
}): Promise<DeliveryPolicyRow | null> {
  return transaction(async (client) => {
    const before = await selectPolicy(client, params.id, true);
    if (!before) return null;
    assertOptimisticVersion({ expectedUpdatedAt: params.body.expected_updated_at, currentUpdatedAt: before.updated_at });
    assertDeliveryPolicyTransition(before.status, params.body.target_status);
    const command = await acquireCommand({ client, actor: params.actor, idempotencyKeyRaw: params.idempotencyKey, commandType: "quality.delivery-policy.transition", payload: { id: params.id, ...params.body } });
    if (command.replayId) return (await selectPolicy(client, command.replayId)) ?? before;

    if (params.body.target_status === "SIGNED" && (!params.body.signature_reference || !params.body.document_reference)) {
      throw new HttpError(422, "QUALITY_POLICY_SIGNATURE_REQUIRED", "La reference de signature et le document signe sont obligatoires.");
    }
    if (params.body.target_status === "REVOKED" && params.body.reason.trim().length < 10) {
      throw new HttpError(422, "QUALITY_POLICY_REVOCATION_REASON_REQUIRED", "La revocation exige un motif d'au moins 10 caracteres.");
    }

    if (params.body.target_status === "ACTIVE") {
      const active = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM public.quality_delivery_release_policy
         WHERE status = 'ACTIVE' AND id <> $1::uuid FOR UPDATE`,
        [params.id]
      );
      for (const row of active.rows) {
        await client.query(
          `UPDATE public.quality_delivery_release_policy
           SET status = 'SUPERSEDED', superseded_by_policy_id = $2::uuid,
               superseded_at = now(), updated_by = $3, updated_at = now()
           WHERE id = $1::uuid`,
          [row.id, params.id, params.actor.user_id]
        );
        const superseded = (await selectPolicy(client, row.id))!;
        await appendEvent({ client, policy: superseded, eventType: "SUPERSEDED", fromStatus: "ACTIVE", reason: params.body.reason, actor: params.actor, idempotencyKey: command.key });
      }
    }

    const eventType = params.body.target_status === "IN_REVIEW" ? "SUBMITTED" : params.body.target_status;
    await client.query(
      `UPDATE public.quality_delivery_release_policy
       SET status = $2,
           submitted_by = CASE WHEN $2 = 'IN_REVIEW' THEN $3 ELSE submitted_by END,
           submitted_at = CASE WHEN $2 = 'IN_REVIEW' THEN now() ELSE submitted_at END,
           signed_by = CASE WHEN $2 = 'SIGNED' THEN $3 ELSE signed_by END,
           signed_at = CASE WHEN $2 = 'SIGNED' THEN now() ELSE signed_at END,
           signature_reference = CASE WHEN $2 = 'SIGNED' THEN $4 ELSE signature_reference END,
           document_reference = CASE WHEN $2 = 'SIGNED' THEN $5 ELSE document_reference END,
           activated_by = CASE WHEN $2 = 'ACTIVE' THEN $3 ELSE activated_by END,
           activated_at = CASE WHEN $2 = 'ACTIVE' THEN now() ELSE activated_at END,
           revoked_by = CASE WHEN $2 = 'REVOKED' THEN $3 ELSE revoked_by END,
           revoked_at = CASE WHEN $2 = 'REVOKED' THEN now() ELSE revoked_at END,
           revocation_reason = CASE WHEN $2 = 'REVOKED' THEN $6 ELSE revocation_reason END,
           updated_by = $3, updated_at = now()
       WHERE id = $1::uuid`,
      [params.id, params.body.target_status, params.actor.user_id, params.body.signature_reference ?? null, params.body.document_reference ?? null, params.body.reason]
    );
    const policy = (await selectPolicy(client, params.id))!;
    await appendEvent({ client, policy, eventType, fromStatus: before.status, reason: params.body.reason, actor: params.actor, idempotencyKey: command.key });
    await saveReceipt({ client, actor: params.actor, key: command.key, hash: command.hash, commandType: "quality.delivery-policy.transition", payload: { id: params.id, ...params.body }, policy });
    return policy;
  });
}
