import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

import { logger } from "../../../shared/observability/logger";
import { HttpError } from "../../../utils/httpError";
import {
  WEBHOOK_EVENT_REGISTRY,
  assertWebhookTargetPublic,
  generateWebhookSecret,
  parseWebhookEncryptionKey,
  sealWebhookSecret,
  signWebhookPayload,
  unsealWebhookSecret,
  validateWebhookEndpointSyntax,
  webhookEnvelope,
  webhookRetryDelaySeconds,
  type ResolvedWebhookTarget,
  type WebhookEventType,
} from "./webhook.domain";
import {
  repoClaimWebhookDelivery,
  repoCompleteWebhookDelivery,
  repoCreateWebhookSubscription,
  repoEnqueueWebhookTest,
  repoGetWebhookSubscription,
  repoListWebhookDeliveries,
  repoListWebhookSubscriptions,
  repoPatchWebhookSubscription,
  repoProjectWebhookOutboxBatch,
  repoReplayWebhookDelivery,
  repoRotateWebhookSecret,
  type WebhookActor,
  type WebhookDeliveryRow,
  type WebhookSubscriptionRow,
} from "./webhook.repository";

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function requestSha256(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function encryptionKey(): Buffer {
  const key = parseWebhookEncryptionKey(process.env.CERP_WEBHOOK_SECRET_ENCRYPTION_KEY);
  if (!key) {
    throw new HttpError(
      503,
      "WEBHOOK_ENCRYPTION_KEY_NOT_CONFIGURED",
      "La clé de chiffrement des secrets webhook n'est pas configurée.",
    );
  }
  return key;
}

function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("WEBHOOK_TIMESTAMP_INVALID");
  return date.toISOString();
}

function publicSubscription(row: WebhookSubscriptionRow) {
  return {
    id: row.id,
    name: row.name,
    endpoint_url: row.endpoint_url,
    event_types: row.event_types,
    status: row.status,
    secret_hint: row.secret_hint,
    secret_version: row.secret_version,
    consecutive_failure_count: row.consecutive_failure_count,
    disabled_reason: row.disabled_reason,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function publicDelivery(row: WebhookDeliveryRow) {
  return {
    ...row,
    next_attempt_at: iso(row.next_attempt_at),
    delivered_at: row.delivered_at ? iso(row.delivered_at) : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function webhookReadiness() {
  const configured = parseWebhookEncryptionKey(process.env.CERP_WEBHOOK_SECRET_ENCRYPTION_KEY) !== null;
  const enabled = process.env.CERP_WEBHOOK_DELIVERY_ENABLED !== "0";
  return {
    ready: configured && enabled,
    environment: process.env.NODE_ENV === "production" ? "production" : "sandbox",
    encryption_key_configured: configured,
    delivery_enabled: enabled,
    signature_algorithm: "HMAC-SHA256",
    signature_version: "v1",
    replay_window_seconds: 300,
  };
}

export function listWebhookEventRegistry() {
  return {
    api_version: "v1",
    events: WEBHOOK_EVENT_REGISTRY,
    delivery_headers: [
      "CERP-Webhook-Id",
      "CERP-Webhook-Timestamp",
      "CERP-Webhook-Signature",
      "CERP-Webhook-Event",
      "CERP-Webhook-Secret-Version",
    ],
    signature_input: "<timestamp>.<delivery_id>.<raw_body>",
    replay_protection: "Reject timestamps older than 300 seconds and persist each CERP-Webhook-Id once.",
  };
}

export async function listWebhookSubscriptions() {
  return (await repoListWebhookSubscriptions()).map(publicSubscription);
}

export async function createWebhookSubscription(params: {
  name: string;
  endpointUrl: string;
  eventTypes: readonly string[];
  actor: WebhookActor;
  idempotencyKey: string;
}) {
  const endpoint = validateWebhookEndpointSyntax(params.endpointUrl);
  const eventTypes = params.eventTypes as readonly WebhookEventType[];
  const secret = generateWebhookSecret();
  const sealed = sealWebhookSecret(secret, encryptionKey());
  const result = await repoCreateWebhookSubscription({
    name: params.name,
    endpointUrl: endpoint,
    eventTypes,
    sealedSecret: sealed,
    secretHint: secret.slice(-8),
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
    requestSha256: requestSha256({ name: params.name, endpoint_url: endpoint, event_types: eventTypes }),
  });
  const returnedSecret = result.idempotentReplay
    ? unsealWebhookSecret(result.sealedSecret, encryptionKey())
    : secret;
  return {
    subscription: publicSubscription(result.subscription),
    secret: returnedSecret,
    idempotent_replay: result.idempotentReplay,
  };
}

export async function patchWebhookSubscription(params: {
  id: string;
  expectedUpdatedAt: string;
  name?: string;
  endpointUrl?: string;
  eventTypes?: readonly string[];
  status?: "ACTIVE" | "PAUSED" | "DISABLED";
  actor: WebhookActor;
  idempotencyKey: string;
}) {
  const endpoint = params.endpointUrl === undefined ? undefined : validateWebhookEndpointSyntax(params.endpointUrl);
  const eventTypes = params.eventTypes as readonly WebhookEventType[] | undefined;
  const input = {
    id: params.id,
    expected_updated_at: params.expectedUpdatedAt,
    name: params.name,
    endpoint_url: endpoint,
    event_types: eventTypes,
    status: params.status,
  };
  const result = await repoPatchWebhookSubscription({
    id: params.id,
    expectedUpdatedAt: params.expectedUpdatedAt,
    name: params.name,
    endpointUrl: endpoint,
    eventTypes,
    status: params.status,
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
    requestSha256: requestSha256(input),
  });
  return { subscription: publicSubscription(result.subscription), idempotent_replay: result.idempotentReplay };
}

export async function rotateWebhookSecret(params: {
  id: string;
  expectedUpdatedAt: string;
  actor: WebhookActor;
  idempotencyKey: string;
}) {
  const secret = generateWebhookSecret();
  const sealed = sealWebhookSecret(secret, encryptionKey());
  const result = await repoRotateWebhookSecret({
    id: params.id,
    expectedUpdatedAt: params.expectedUpdatedAt,
    sealedSecret: sealed,
    secretHint: secret.slice(-8),
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
    requestSha256: requestSha256({ id: params.id, expected_updated_at: params.expectedUpdatedAt }),
  });
  return {
    subscription: publicSubscription(result.subscription),
    secret: result.idempotentReplay ? unsealWebhookSecret(result.sealedSecret, encryptionKey()) : secret,
    idempotent_replay: result.idempotentReplay,
  };
}

export async function enqueueWebhookTest(params: {
  subscriptionId: string;
  actor: WebhookActor;
  idempotencyKey: string;
}) {
  encryptionKey();
  const result = await repoEnqueueWebhookTest({
    subscriptionId: params.subscriptionId,
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
    requestSha256: requestSha256({ subscription_id: params.subscriptionId, event_type: "erp.webhook.test.v1" }),
  });
  return { delivery: publicDelivery(result.delivery), idempotent_replay: result.idempotentReplay };
}

export async function listWebhookDeliveries(params: {
  subscriptionId?: string;
  status?: WebhookDeliveryRow["status"];
  limit: number;
}) {
  return (await repoListWebhookDeliveries(params)).map(publicDelivery);
}

export async function replayWebhookDelivery(params: {
  deliveryId: string;
  actor: WebhookActor;
  idempotencyKey: string;
}) {
  encryptionKey();
  const result = await repoReplayWebhookDelivery({
    deliveryId: params.deliveryId,
    actor: params.actor,
    idempotencyKey: params.idempotencyKey,
    requestSha256: requestSha256({ delivery_id: params.deliveryId }),
  });
  return { delivery: publicDelivery(result.delivery), idempotent_replay: result.idempotentReplay };
}

type WebhookFetch = typeof fetch;

async function postWebhookWithPinnedTarget(params: {
  endpointUrl: string;
  target: ResolvedWebhookTarget;
  headers: Record<string, string>;
  rawBody: Buffer;
  timeoutMs: number;
}): Promise<number> {
  const endpoint = new URL(params.endpointUrl);
  const tlsHostname = endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]")
    ? endpoint.hostname.slice(1, -1)
    : endpoint.hostname;
  const transport = endpoint.protocol === "https:" ? https : http;
  return new Promise<number>((resolve, reject) => {
    const request = transport.request(endpoint, {
      method: "POST",
      headers: params.headers,
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [{ address: params.target.address, family: params.target.family }]);
          return;
        }
        callback(null, params.target.address, params.target.family);
      },
      ...(endpoint.protocol === "https:" && net.isIP(tlsHostname) === 0 ? { servername: tlsHostname } : {}),
    }, (response) => {
      const status = response.statusCode;
      response.resume();
      if (!status) reject(new Error("WEBHOOK_RESPONSE_STATUS_MISSING"));
      else resolve(status);
    });
    request.setTimeout(params.timeoutMs, () => request.destroy(new Error("WEBHOOK_TIMEOUT")));
    request.on("error", reject);
    request.end(params.rawBody);
  });
}

function safeDeliveryError(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  if (/PRIVATE_NETWORK/.test(message)) return "WEBHOOK_TARGET_PRIVATE_NETWORK";
  if (/DNS/.test(message)) return "WEBHOOK_TARGET_DNS_ERROR";
  if (/TIMEOUT|Abort/i.test(message)) return "WEBHOOK_TIMEOUT";
  if (/ENCRYPTION|Unsupported state|authenticate data/i.test(message)) return "WEBHOOK_SECRET_DECRYPTION_FAILED";
  return "WEBHOOK_NETWORK_ERROR";
}

export async function processNextWebhookDelivery(fetchImpl?: WebhookFetch): Promise<boolean> {
  await repoProjectWebhookOutboxBatch(100);
  const claim = await repoClaimWebhookDelivery();
  if (!claim) return false;
  const startedAt = Date.now();
  let httpStatus: number | null = null;
  let errorCode: string | null = null;
  let delivered = false;
  let retryable = false;
  let disableSubscription = false;
  try {
    const target = await assertWebhookTargetPublic(claim.endpointUrl);
    const secret = unsealWebhookSecret(claim.secret, encryptionKey());
    const envelope = webhookEnvelope({
      id: claim.eventId,
      type: claim.eventType,
      createdAt: claim.eventCreatedAt,
      payload: claim.payload,
    });
    const rawBody = Buffer.from(JSON.stringify(envelope), "utf8");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const configuredTimeout = Number.parseInt(process.env.CERP_WEBHOOK_HTTP_TIMEOUT_MS ?? "10000", 10);
    const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1000 && configuredTimeout <= 30000
      ? configuredTimeout
      : 10000;
    const headers = {
      "content-type": "application/json",
      "content-length": String(rawBody.length),
      "user-agent": "CERP-Webhook/1.0",
      "cerp-webhook-id": claim.deliveryId,
      "cerp-webhook-timestamp": timestamp,
      "cerp-webhook-signature": signWebhookPayload(secret, timestamp, claim.deliveryId, rawBody),
      "cerp-webhook-event": claim.eventType,
      "cerp-webhook-secret-version": String(claim.secretVersion),
    };
    if (fetchImpl) {
      const response = await fetchImpl(claim.endpointUrl, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers,
        body: rawBody,
      });
      httpStatus = response.status;
      await response.body?.cancel().catch(() => undefined);
    } else {
      httpStatus = await postWebhookWithPinnedTarget({
        endpointUrl: claim.endpointUrl,
        target,
        headers,
        rawBody,
        timeoutMs,
      });
    }
    delivered = httpStatus >= 200 && httpStatus < 300;
    retryable = httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500;
    disableSubscription = [401, 403, 404, 410].includes(httpStatus);
    if (!delivered) errorCode = `WEBHOOK_HTTP_${httpStatus}`;
  } catch (error) {
    retryable = true;
    errorCode = safeDeliveryError(error);
    disableSubscription = errorCode === "WEBHOOK_TARGET_PRIVATE_NETWORK" || errorCode === "WEBHOOK_SECRET_DECRYPTION_FAILED";
  }
  const nextAttempt = claim.attemptCount + 1;
  const exhausted = nextAttempt >= 8;
  const outcome = delivered ? "DELIVERED" : retryable && !exhausted && !disableSubscription ? "RETRY" : "DEAD_LETTER";
  await repoCompleteWebhookDelivery({
    claim,
    outcome,
    httpStatus,
    errorCode,
    durationMs: Math.min(120000, Math.max(0, Date.now() - startedAt)),
    retryDelaySeconds: outcome === "RETRY" ? webhookRetryDelaySeconds(nextAttempt) : null,
    disableSubscription,
  });
  logger.info("webhook_delivery_completed", {
    webhook_delivery_id: claim.deliveryId,
    webhook_event_type: claim.eventType,
    outcome,
    http_status: httpStatus,
    failure_code: errorCode,
  });
  return true;
}

export function startWebhookDeliveryMaintenance(): () => void {
  if (process.env.CERP_WEBHOOK_DELIVERY_ENABLED === "0") {
    logger.warn("webhook_delivery_disabled", { reason_code: "EXPLICITLY_DISABLED" });
    return () => undefined;
  }
  if (!parseWebhookEncryptionKey(process.env.CERP_WEBHOOK_SECRET_ENCRYPTION_KEY)) {
    logger.error("webhook_delivery_degraded", { reason_code: "ENCRYPTION_KEY_NOT_CONFIGURED" });
    return () => undefined;
  }
  const configured = Number.parseInt(process.env.CERP_WEBHOOK_JOB_INTERVAL_MS ?? "30000", 10);
  const intervalMs = Number.isSafeInteger(configured) && configured >= 5000 ? configured : 30000;
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (let processed = 0; processed < 25; processed += 1) {
        if (!(await processNextWebhookDelivery())) break;
      }
    } catch (error) {
      logger.error("webhook_delivery_worker_failed", { failure_code: safeDeliveryError(error) });
    } finally {
      running = false;
    }
  };
  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function getWebhookSubscription(id: string) {
  const row = await repoGetWebhookSubscription(id);
  if (!row) throw new HttpError(404, "WEBHOOK_SUBSCRIPTION_NOT_FOUND", "Abonnement webhook introuvable.");
  return publicSubscription(row);
}
