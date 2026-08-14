import crypto from "node:crypto";
import type { PoolClient } from "pg";

import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import {
  projectOutboxEvent,
  type OutboxProjectionInput,
  type SealedWebhookSecret,
  type WebhookEventType,
} from "./webhook.domain";

export type WebhookActor = { userId: number; requestId: string };

export type WebhookSubscriptionRow = {
  id: string;
  name: string;
  endpoint_url: string;
  event_types: string[];
  status: "ACTIVE" | "PAUSED" | "DISABLED";
  secret_ciphertext: string;
  secret_iv: string;
  secret_tag: string;
  secret_hint: string;
  secret_version: number;
  consecutive_failure_count: number;
  disabled_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type WebhookDeliveryRow = {
  id: string;
  subscription_id: string;
  event_id: string;
  replay_of_delivery_id: string | null;
  status: "PENDING" | "PROCESSING" | "RETRY" | "DELIVERED" | "DEAD_LETTER" | "CANCELLED";
  attempt_count: number;
  next_attempt_at: string;
  last_http_status: number | null;
  last_error_code: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
  event_type?: WebhookEventType;
};

export type ClaimedWebhookDelivery = {
  deliveryId: string;
  subscriptionId: string;
  endpointUrl: string;
  secret: SealedWebhookSecret;
  secretVersion: number;
  eventId: string;
  eventType: WebhookEventType;
  eventCreatedAt: string;
  payload: Record<string, unknown>;
  attemptCount: number;
  leaseToken: string;
};

type StoredCommandResult = Record<string, unknown>;

async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let destroyed = false;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyed = true;
      client.release(true);
      throw error;
    }
    throw error;
  } finally {
    if (!destroyed) client.release();
  }
}

async function readCommandReceipt(
  client: PoolClient,
  action: string,
  actorId: number,
  idempotencyKey: string,
  requestSha256: string,
): Promise<StoredCommandResult | null> {
  const result = await client.query<{ request_sha256: string; result: StoredCommandResult }>(
    `SELECT request_sha256, result
       FROM public.api_webhook_command_receipts
      WHERE actor_id=$1 AND action=$2 AND idempotency_key=$3::uuid
      FOR UPDATE`,
    [actorId, action, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.request_sha256 !== requestSha256) {
    throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "Cette clé d'idempotence a déjà servi pour une autre commande.");
  }
  return row.result;
}

async function saveCommandReceipt(
  client: PoolClient,
  action: string,
  actorId: number,
  idempotencyKey: string,
  requestSha256: string,
  result: StoredCommandResult,
): Promise<void> {
  await client.query(
    `INSERT INTO public.api_webhook_command_receipts(actor_id,action,idempotency_key,request_sha256,result)
     VALUES($1,$2,$3::uuid,$4,$5::jsonb)`,
    [actorId, action, idempotencyKey, requestSha256, JSON.stringify(result)],
  );
}

async function audit(
  client: PoolClient,
  actor: WebhookActor | null,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO public.api_webhook_audit_events(actor_id,action,entity_type,entity_id,request_id,details)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [actor?.userId ?? null, action, entityType, entityId, actor?.requestId ?? null, JSON.stringify(details)],
  );
}

const subscriptionColumns = `
  id::text,name,endpoint_url,event_types,status,secret_ciphertext,secret_iv,secret_tag,secret_hint,
  secret_version,consecutive_failure_count,disabled_reason,created_at::text,updated_at::text
`;

export async function repoListWebhookSubscriptions(): Promise<WebhookSubscriptionRow[]> {
  const result = await pool.query<WebhookSubscriptionRow>(
    `SELECT ${subscriptionColumns}
       FROM public.api_webhook_subscriptions
      ORDER BY lower(name), id`,
  );
  return result.rows;
}

export async function repoGetWebhookSubscription(id: string): Promise<WebhookSubscriptionRow | null> {
  const result = await pool.query<WebhookSubscriptionRow>(
    `SELECT ${subscriptionColumns}
       FROM public.api_webhook_subscriptions
      WHERE id=$1::uuid`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function repoCreateWebhookSubscription(params: {
  name: string;
  endpointUrl: string;
  eventTypes: readonly WebhookEventType[];
  sealedSecret: SealedWebhookSecret;
  secretHint: string;
  actor: WebhookActor;
  idempotencyKey: string;
  requestSha256: string;
}): Promise<{ subscription: WebhookSubscriptionRow; sealedSecret: SealedWebhookSecret; idempotentReplay: boolean }> {
  return transaction(async (client) => {
    const action = "WEBHOOK_SUBSCRIPTION_CREATE";
    const receipt = await readCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256);
    if (receipt) {
      const subscriptionId = String(receipt.subscription_id ?? "");
      const subscription = await client.query<WebhookSubscriptionRow>(
        `SELECT ${subscriptionColumns} FROM public.api_webhook_subscriptions WHERE id=$1::uuid`,
        [subscriptionId],
      );
      const storedSealed = receipt.sealed_secret as SealedWebhookSecret | undefined;
      if (!subscription.rows[0] || !storedSealed) throw new HttpError(409, "WEBHOOK_IDEMPOTENCY_EVIDENCE_INVALID", "Le reçu de création est incomplet.");
      return { subscription: subscription.rows[0], sealedSecret: storedSealed, idempotentReplay: true };
    }
    const inserted = await client.query<WebhookSubscriptionRow>(
      `INSERT INTO public.api_webhook_subscriptions(
         name,endpoint_url,event_types,secret_ciphertext,secret_iv,secret_tag,secret_hint,created_by,updated_by
       ) VALUES($1,$2,$3::text[],$4,$5,$6,$7,$8,$8)
       RETURNING ${subscriptionColumns}`,
      [
        params.name,
        params.endpointUrl,
        [...params.eventTypes],
        params.sealedSecret.ciphertext,
        params.sealedSecret.iv,
        params.sealedSecret.tag,
        params.secretHint,
        params.actor.userId,
      ],
    );
    const subscription = inserted.rows[0];
    if (!subscription) throw new Error("WEBHOOK_SUBSCRIPTION_INSERT_FAILED");
    await saveCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256, {
      subscription_id: subscription.id,
      sealed_secret: params.sealedSecret,
    });
    await audit(client, params.actor, "webhook.subscription.created", "webhook_subscription", subscription.id, {
      event_types: params.eventTypes,
      endpoint_origin: new URL(params.endpointUrl).origin,
    });
    return { subscription, sealedSecret: params.sealedSecret, idempotentReplay: false };
  });
}

export async function repoPatchWebhookSubscription(params: {
  id: string;
  expectedUpdatedAt: string;
  name?: string;
  endpointUrl?: string;
  eventTypes?: readonly WebhookEventType[];
  status?: "ACTIVE" | "PAUSED" | "DISABLED";
  actor: WebhookActor;
  idempotencyKey: string;
  requestSha256: string;
}): Promise<{ subscription: WebhookSubscriptionRow; idempotentReplay: boolean }> {
  return transaction(async (client) => {
    const action = "WEBHOOK_SUBSCRIPTION_PATCH";
    const receipt = await readCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256);
    if (receipt) {
      const replay = await client.query<WebhookSubscriptionRow>(
        `SELECT ${subscriptionColumns} FROM public.api_webhook_subscriptions WHERE id=$1::uuid`,
        [String(receipt.subscription_id ?? "")],
      );
      if (!replay.rows[0]) throw new HttpError(409, "WEBHOOK_IDEMPOTENCY_EVIDENCE_INVALID", "Le reçu de modification est incomplet.");
      return { subscription: replay.rows[0], idempotentReplay: true };
    }
    const updated = await client.query<WebhookSubscriptionRow>(
      `UPDATE public.api_webhook_subscriptions
          SET name=COALESCE($2,name), endpoint_url=COALESCE($3,endpoint_url),
              event_types=COALESCE($4::text[],event_types), status=COALESCE($5,status),
              disabled_reason=CASE WHEN $5='DISABLED' THEN 'MANUAL' WHEN $5='ACTIVE' THEN NULL ELSE disabled_reason END,
              consecutive_failure_count=CASE WHEN $5='ACTIVE' THEN 0 ELSE consecutive_failure_count END,
              updated_by=$6, updated_at=now()
        WHERE id=$1::uuid AND updated_at=$7::timestamptz
        RETURNING ${subscriptionColumns}`,
      [params.id, params.name ?? null, params.endpointUrl ?? null, params.eventTypes ? [...params.eventTypes] : null, params.status ?? null, params.actor.userId, params.expectedUpdatedAt],
    );
    const subscription = updated.rows[0];
    if (!subscription) {
      const exists = await client.query("SELECT 1 FROM public.api_webhook_subscriptions WHERE id=$1::uuid", [params.id]);
      throw new HttpError(exists.rowCount ? 409 : 404, exists.rowCount ? "WEBHOOK_SUBSCRIPTION_VERSION_CONFLICT" : "WEBHOOK_SUBSCRIPTION_NOT_FOUND", exists.rowCount ? "L'abonnement a changé. Rechargez-le." : "Abonnement webhook introuvable.");
    }
    await saveCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256, { subscription_id: subscription.id });
    await audit(client, params.actor, "webhook.subscription.updated", "webhook_subscription", subscription.id, {
      changed_fields: [
        params.name !== undefined ? "name" : null,
        params.endpointUrl !== undefined ? "endpoint_url" : null,
        params.eventTypes !== undefined ? "event_types" : null,
        params.status !== undefined ? "status" : null,
      ].filter(Boolean),
    });
    return { subscription, idempotentReplay: false };
  });
}

export async function repoRotateWebhookSecret(params: {
  id: string;
  expectedUpdatedAt: string;
  sealedSecret: SealedWebhookSecret;
  secretHint: string;
  actor: WebhookActor;
  idempotencyKey: string;
  requestSha256: string;
}): Promise<{ subscription: WebhookSubscriptionRow; sealedSecret: SealedWebhookSecret; idempotentReplay: boolean }> {
  return transaction(async (client) => {
    const action = "WEBHOOK_SECRET_ROTATE";
    const receipt = await readCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256);
    if (receipt) {
      const replay = await client.query<WebhookSubscriptionRow>(
        `SELECT ${subscriptionColumns} FROM public.api_webhook_subscriptions WHERE id=$1::uuid`,
        [String(receipt.subscription_id ?? "")],
      );
      const storedSealed = receipt.sealed_secret as SealedWebhookSecret | undefined;
      if (!replay.rows[0] || !storedSealed) throw new HttpError(409, "WEBHOOK_IDEMPOTENCY_EVIDENCE_INVALID", "Le reçu de rotation est incomplet.");
      return { subscription: replay.rows[0], sealedSecret: storedSealed, idempotentReplay: true };
    }
    const updated = await client.query<WebhookSubscriptionRow>(
      `UPDATE public.api_webhook_subscriptions
          SET secret_ciphertext=$2, secret_iv=$3, secret_tag=$4, secret_hint=$5,
              secret_version=secret_version+1, updated_by=$6, updated_at=now()
        WHERE id=$1::uuid AND updated_at=$7::timestamptz
        RETURNING ${subscriptionColumns}`,
      [params.id, params.sealedSecret.ciphertext, params.sealedSecret.iv, params.sealedSecret.tag, params.secretHint, params.actor.userId, params.expectedUpdatedAt],
    );
    const subscription = updated.rows[0];
    if (!subscription) {
      const exists = await client.query("SELECT 1 FROM public.api_webhook_subscriptions WHERE id=$1::uuid", [params.id]);
      throw new HttpError(exists.rowCount ? 409 : 404, exists.rowCount ? "WEBHOOK_SUBSCRIPTION_VERSION_CONFLICT" : "WEBHOOK_SUBSCRIPTION_NOT_FOUND", exists.rowCount ? "L'abonnement a changé. Rechargez-le." : "Abonnement webhook introuvable.");
    }
    await saveCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256, {
      subscription_id: subscription.id,
      sealed_secret: params.sealedSecret,
    });
    await audit(client, params.actor, "webhook.secret.rotated", "webhook_subscription", subscription.id, { secret_version: subscription.secret_version });
    return { subscription, sealedSecret: params.sealedSecret, idempotentReplay: false };
  });
}

export async function repoEnqueueWebhookTest(params: {
  subscriptionId: string;
  actor: WebhookActor;
  idempotencyKey: string;
  requestSha256: string;
}): Promise<{ delivery: WebhookDeliveryRow; idempotentReplay: boolean }> {
  return transaction(async (client) => {
    const action = "WEBHOOK_TEST_ENQUEUE";
    const receipt = await readCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256);
    if (receipt) {
      const replay = await client.query<WebhookDeliveryRow>(
        `SELECT id::text,subscription_id::text,event_id::text,replay_of_delivery_id::text,status,attempt_count,
                next_attempt_at::text,last_http_status,last_error_code,delivered_at::text,created_at::text,updated_at::text
           FROM public.api_webhook_deliveries WHERE id=$1::uuid`,
        [String(receipt.delivery_id ?? "")],
      );
      if (!replay.rows[0]) throw new HttpError(409, "WEBHOOK_IDEMPOTENCY_EVIDENCE_INVALID", "Le reçu de test est incomplet.");
      return { delivery: replay.rows[0], idempotentReplay: true };
    }
    const subscription = await client.query<{ id: string }>(
      "SELECT id::text FROM public.api_webhook_subscriptions WHERE id=$1::uuid AND status='ACTIVE' FOR UPDATE",
      [params.subscriptionId],
    );
    if (!subscription.rows[0]) throw new HttpError(409, "WEBHOOK_SUBSCRIPTION_NOT_ACTIVE", "L'abonnement doit être actif pour envoyer un test.");
    const now = new Date().toISOString();
    const payload = { subscription_id: params.subscriptionId, requested_at: now };
    const payloadSha = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const event = await client.query<{ id: string }>(
      `INSERT INTO public.api_webhook_events(event_type,aggregate_type,aggregate_id,payload,payload_sha256,occurred_at)
       VALUES('erp.webhook.test.v1','WEBHOOK_SUBSCRIPTION',$1,$2::jsonb,$3,$4::timestamptz)
       RETURNING id::text`,
      [params.subscriptionId, JSON.stringify(payload), payloadSha, now],
    );
    const inserted = await client.query<WebhookDeliveryRow>(
      `INSERT INTO public.api_webhook_deliveries(subscription_id,event_id)
       VALUES($1::uuid,$2::uuid)
       RETURNING id::text,subscription_id::text,event_id::text,replay_of_delivery_id::text,status,attempt_count,
                 next_attempt_at::text,last_http_status,last_error_code,delivered_at::text,created_at::text,updated_at::text`,
      [params.subscriptionId, event.rows[0]?.id],
    );
    const delivery = inserted.rows[0];
    if (!delivery) throw new Error("WEBHOOK_TEST_DELIVERY_INSERT_FAILED");
    await saveCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256, { delivery_id: delivery.id });
    await audit(client, params.actor, "webhook.test.enqueued", "webhook_delivery", delivery.id, { subscription_id: params.subscriptionId });
    return { delivery, idempotentReplay: false };
  });
}

export async function repoListWebhookDeliveries(params: {
  subscriptionId?: string;
  status?: WebhookDeliveryRow["status"];
  limit: number;
}): Promise<WebhookDeliveryRow[]> {
  const result = await pool.query<WebhookDeliveryRow>(
    `SELECT d.id::text,d.subscription_id::text,d.event_id::text,d.replay_of_delivery_id::text,d.status,d.attempt_count,
            d.next_attempt_at::text,d.last_http_status,d.last_error_code,d.delivered_at::text,d.created_at::text,d.updated_at::text,
            e.event_type
       FROM public.api_webhook_deliveries d
       JOIN public.api_webhook_events e ON e.id=d.event_id
      WHERE ($1::uuid IS NULL OR d.subscription_id=$1::uuid) AND ($2::text IS NULL OR d.status=$2)
      ORDER BY d.created_at DESC,d.id DESC LIMIT $3`,
    [params.subscriptionId ?? null, params.status ?? null, params.limit],
  );
  return result.rows;
}

export async function repoReplayWebhookDelivery(params: {
  deliveryId: string;
  actor: WebhookActor;
  idempotencyKey: string;
  requestSha256: string;
}): Promise<{ delivery: WebhookDeliveryRow; idempotentReplay: boolean }> {
  return transaction(async (client) => {
    const action = "WEBHOOK_DELIVERY_REPLAY";
    const receipt = await readCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256);
    if (receipt) {
      const replay = await client.query<WebhookDeliveryRow>(
        `SELECT id::text,subscription_id::text,event_id::text,replay_of_delivery_id::text,status,attempt_count,
                next_attempt_at::text,last_http_status,last_error_code,delivered_at::text,created_at::text,updated_at::text
           FROM public.api_webhook_deliveries WHERE id=$1::uuid`,
        [String(receipt.delivery_id ?? "")],
      );
      if (!replay.rows[0]) throw new HttpError(409, "WEBHOOK_IDEMPOTENCY_EVIDENCE_INVALID", "Le reçu de rejeu est incomplet.");
      return { delivery: replay.rows[0], idempotentReplay: true };
    }
    const original = await client.query<{ subscription_id: string; event_id: string; status: string }>(
      `SELECT subscription_id::text,event_id::text,status FROM public.api_webhook_deliveries WHERE id=$1::uuid FOR UPDATE`,
      [params.deliveryId],
    );
    const source = original.rows[0];
    if (!source) throw new HttpError(404, "WEBHOOK_DELIVERY_NOT_FOUND", "Livraison webhook introuvable.");
    if (!['DELIVERED','DEAD_LETTER','CANCELLED'].includes(source.status)) {
      throw new HttpError(409, "WEBHOOK_DELIVERY_NOT_REPLAYABLE", "Seule une livraison terminale peut être rejouée.");
    }
    const subscription = await client.query("SELECT 1 FROM public.api_webhook_subscriptions WHERE id=$1::uuid AND status='ACTIVE'", [source.subscription_id]);
    if (!subscription.rowCount) throw new HttpError(409, "WEBHOOK_SUBSCRIPTION_NOT_ACTIVE", "Réactivez l'abonnement avant le rejeu.");
    const inserted = await client.query<WebhookDeliveryRow>(
      `INSERT INTO public.api_webhook_deliveries(subscription_id,event_id,replay_of_delivery_id)
       VALUES($1::uuid,$2::uuid,$3::uuid)
       RETURNING id::text,subscription_id::text,event_id::text,replay_of_delivery_id::text,status,attempt_count,
                 next_attempt_at::text,last_http_status,last_error_code,delivered_at::text,created_at::text,updated_at::text`,
      [source.subscription_id, source.event_id, params.deliveryId],
    );
    const delivery = inserted.rows[0];
    if (!delivery) throw new Error("WEBHOOK_REPLAY_INSERT_FAILED");
    await saveCommandReceipt(client, action, params.actor.userId, params.idempotencyKey, params.requestSha256, { delivery_id: delivery.id });
    await audit(client, params.actor, "webhook.delivery.replayed", "webhook_delivery", delivery.id, { replay_of_delivery_id: params.deliveryId });
    return { delivery, idempotentReplay: false };
  });
}

export async function repoProjectWebhookOutboxBatch(limit = 100): Promise<number> {
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(860828001)");
    const state = await client.query<{ last_outbox_created_at: string; last_outbox_id: string }>(
      `SELECT last_outbox_created_at::text,last_outbox_id::text
         FROM public.api_webhook_ingestion_state WHERE singleton FOR UPDATE`,
    );
    const cursor = state.rows[0];
    if (!cursor) throw new Error("WEBHOOK_INGESTION_CURSOR_MISSING");
    const rows = await client.query<OutboxProjectionInput>(
      `SELECT id::text,aggregate_type,aggregate_id,event_type,payload,created_at
         FROM public.erp_outbox_events
        WHERE (created_at,id) > ($1::timestamptz,$2::uuid)
        ORDER BY created_at,id LIMIT $3`,
      [cursor.last_outbox_created_at, cursor.last_outbox_id, Math.max(1, Math.min(500, limit))],
    );
    for (const row of rows.rows) {
      const projection = projectOutboxEvent(row);
      if (!projection) continue;
      const subscriptions = await client.query<{ id: string }>(
        `SELECT id::text FROM public.api_webhook_subscriptions
          WHERE status='ACTIVE' AND $1=ANY(event_types) ORDER BY id`,
        [projection.eventType],
      );
      if (subscriptions.rowCount === 0) continue;
      const payloadJson = JSON.stringify(projection.payload);
      const payloadSha = crypto.createHash("sha256").update(payloadJson).digest("hex");
      const event = await client.query<{ id: string }>(
        `INSERT INTO public.api_webhook_events(source_outbox_id,event_type,aggregate_type,aggregate_id,payload,payload_sha256,occurred_at)
         VALUES($1::uuid,$2,$3,$4,$5::jsonb,$6,$7::timestamptz)
         ON CONFLICT (source_outbox_id) WHERE source_outbox_id IS NOT NULL
         DO UPDATE SET source_outbox_id=EXCLUDED.source_outbox_id
         RETURNING id::text`,
        [row.id, projection.eventType, projection.aggregateType, projection.aggregateId, payloadJson, payloadSha, projection.occurredAt],
      );
      const eventId = event.rows[0]?.id;
      if (!eventId) throw new Error("WEBHOOK_EVENT_INSERT_FAILED");
      for (const subscription of subscriptions.rows) {
        await client.query(
          `INSERT INTO public.api_webhook_deliveries(subscription_id,event_id)
           VALUES($1::uuid,$2::uuid) ON CONFLICT DO NOTHING`,
          [subscription.id, eventId],
        );
      }
    }
    const last = rows.rows.at(-1);
    if (last) {
      await client.query(
        `UPDATE public.api_webhook_ingestion_state
            SET last_outbox_created_at=$1::timestamptz,last_outbox_id=$2::uuid,updated_at=now()
          WHERE singleton`,
        [last.created_at, last.id],
      );
    }
    return rows.rowCount ?? 0;
  });
}

export async function repoClaimWebhookDelivery(): Promise<ClaimedWebhookDelivery | null> {
  const leaseToken = crypto.randomUUID();
  const result = await pool.query<{
    delivery_id: string; subscription_id: string; endpoint_url: string; secret_ciphertext: string; secret_iv: string;
    secret_tag: string; secret_version: number; event_id: string; event_type: WebhookEventType; event_created_at: string;
    payload: Record<string, unknown>; attempt_count: number;
  }>(
    `WITH candidate AS (
       SELECT d.id
         FROM public.api_webhook_deliveries d
         JOIN public.api_webhook_subscriptions s ON s.id=d.subscription_id AND s.status='ACTIVE'
        WHERE (d.status IN ('PENDING','RETRY') AND d.next_attempt_at<=now())
           OR (d.status='PROCESSING' AND d.lease_expires_at<=now())
        ORDER BY d.next_attempt_at,d.created_at,d.id
        FOR UPDATE OF d SKIP LOCKED LIMIT 1
     ), claimed AS (
       UPDATE public.api_webhook_deliveries d
          SET status='PROCESSING',lease_token=$1::uuid,lease_expires_at=now()+interval '2 minutes',updated_at=now()
         FROM candidate WHERE d.id=candidate.id
       RETURNING d.*
     )
     SELECT claimed.id::text AS delivery_id,claimed.subscription_id::text,s.endpoint_url,s.secret_ciphertext,s.secret_iv,
            s.secret_tag,s.secret_version,e.id::text AS event_id,e.event_type,e.occurred_at::text AS event_created_at,
            e.payload,claimed.attempt_count
       FROM claimed
       JOIN public.api_webhook_subscriptions s ON s.id=claimed.subscription_id
       JOIN public.api_webhook_events e ON e.id=claimed.event_id`,
    [leaseToken],
  );
  const row = result.rows[0];
  return row ? {
    deliveryId: row.delivery_id,
    subscriptionId: row.subscription_id,
    endpointUrl: row.endpoint_url,
    secret: { ciphertext: row.secret_ciphertext, iv: row.secret_iv, tag: row.secret_tag },
    secretVersion: row.secret_version,
    eventId: row.event_id,
    eventType: row.event_type,
    eventCreatedAt: row.event_created_at,
    payload: row.payload,
    attemptCount: row.attempt_count,
    leaseToken,
  } : null;
}

export async function repoCompleteWebhookDelivery(params: {
  claim: ClaimedWebhookDelivery;
  outcome: "DELIVERED" | "RETRY" | "DEAD_LETTER";
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number;
  retryDelaySeconds: number | null;
  disableSubscription: boolean;
}): Promise<void> {
  await transaction(async (client) => {
    const locked = await client.query<{ attempt_count: number }>(
      `SELECT attempt_count FROM public.api_webhook_deliveries
        WHERE id=$1::uuid AND status='PROCESSING' AND lease_token=$2::uuid FOR UPDATE`,
      [params.claim.deliveryId, params.claim.leaseToken],
    );
    const current = locked.rows[0];
    if (!current) throw new Error("WEBHOOK_DELIVERY_LEASE_LOST");
    const attempt = current.attempt_count + 1;
    await client.query(
      `INSERT INTO public.api_webhook_delivery_attempts(delivery_id,attempt_number,outcome,http_status,error_code,duration_ms)
       VALUES($1::uuid,$2,$3,$4,$5,$6)`,
      [params.claim.deliveryId, attempt, params.outcome, params.httpStatus, params.errorCode, params.durationMs],
    );
    await client.query(
      `UPDATE public.api_webhook_deliveries
          SET status=$3,attempt_count=$4,next_attempt_at=CASE WHEN $3='RETRY' THEN now()+make_interval(secs=>$5) ELSE next_attempt_at END,
              lease_token=NULL,lease_expires_at=NULL,last_http_status=$6,last_error_code=$7,
              response_fingerprint=$8,delivered_at=CASE WHEN $3='DELIVERED' THEN now() ELSE delivered_at END,updated_at=now()
        WHERE id=$1::uuid AND lease_token=$2::uuid`,
      [
        params.claim.deliveryId,
        params.claim.leaseToken,
        params.outcome,
        attempt,
        params.retryDelaySeconds ?? 0,
        params.httpStatus,
        params.errorCode,
        params.httpStatus ? crypto.createHash("sha256").update(String(params.httpStatus)).digest("hex") : null,
      ],
    );
    if (params.outcome === "DELIVERED") {
      await client.query(
        "UPDATE public.api_webhook_subscriptions SET consecutive_failure_count=0,updated_at=now() WHERE id=$1::uuid",
        [params.claim.subscriptionId],
      );
    } else {
      await client.query(
        `UPDATE public.api_webhook_subscriptions
            SET consecutive_failure_count=consecutive_failure_count+1,
                status=CASE WHEN $2 THEN 'DISABLED' ELSE status END,
                disabled_reason=CASE WHEN $2 THEN $3 ELSE disabled_reason END,updated_at=now()
          WHERE id=$1::uuid`,
        [params.claim.subscriptionId, params.disableSubscription, params.disableSubscription ? (params.errorCode ?? "REMOTE_DISABLED") : null],
      );
      if (params.disableSubscription) {
        await audit(client, null, "webhook.subscription.auto_disabled", "webhook_subscription", params.claim.subscriptionId, {
          delivery_id: params.claim.deliveryId,
          http_status: params.httpStatus,
          error_code: params.errorCode,
        });
      }
    }
  });
}
