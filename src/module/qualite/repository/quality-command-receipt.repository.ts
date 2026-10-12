import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import {
  normalizeQualityIdempotencyKey,
  qualityRequestHash,
  decideQualityReceipt,
} from "../domain/quality-policy";

export async function acquireIdempotency(params: {
  client: PoolClient;
  actor: { user_id: number };
  idempotencyKeyRaw: string | null | undefined;
  commandType: string;
  requestPayload: unknown;
}): Promise<{
  idempotencyKey: string;
  requestHash: string;
  replay: Record<string, unknown> | null;
}> {
  const idempotencyKey = normalizeQualityIdempotencyKey(
    params.idempotencyKeyRaw,
  );
  const requestHash = qualityRequestHash(
    params.commandType,
    params.requestPayload,
  );
  await params.client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`quality:${params.actor.user_id}:${idempotencyKey}`],
  );
  const existing = await params.client.query<{
    request_hash: string;
    result_payload: Record<string, unknown>;
  }>(
    `
      SELECT request_hash, result_payload
      FROM public.quality_command_receipts
      WHERE actor_user_id = $1 AND idempotency_key = $2
      LIMIT 1
    `,
    [params.actor.user_id, idempotencyKey],
  );
  const receipt = existing.rows[0] ?? null;
  const decision = decideQualityReceipt(receipt?.request_hash, requestHash);
  if (decision === "CONFLICT") {
    throw new HttpError(
      409,
      "IDEMPOTENCY_KEY_REUSED",
      "Cette Idempotency-Key a déjà été utilisée avec un autre contenu.",
    );
  }
  return {
    idempotencyKey,
    requestHash,
    replay: decision === "REPLAY" ? (receipt?.result_payload ?? null) : null,
  };
}

export async function saveReceipt(params: {
  client: PoolClient;
  actor: { user_id: number };
  idempotencyKey: string;
  requestHash: string;
  commandType: string;
  aggregateType:
    | "PLAN"
    | "CONTROL"
    | "NON_CONFORMITY"
    | "ACTION"
    | "DEROGATION"
    | "RELEASE"
    | "DISPOSITION";
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
    ],
  );
}
