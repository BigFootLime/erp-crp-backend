import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

export const WEBHOOK_EVENT_REGISTRY = [
  {
    type: "erp.entity.changed.v1",
    version: 1,
    description: "Une entité métier autorisée a été créée, modifiée, archivée ou a changé de statut.",
    payloadFields: ["entity_type", "entity_id", "action", "module", "occurred_at"],
  },
  {
    type: "erp.invoice.issued.v1",
    version: 1,
    description: "Une facture a été émise et son identifiant ERP est disponible.",
    payloadFields: ["resource_type", "resource_id", "occurred_at"],
  },
  {
    type: "erp.credit-note.issued.v1",
    version: 1,
    description: "Un avoir a été émis et son identifiant ERP est disponible.",
    payloadFields: ["resource_type", "resource_id", "occurred_at"],
  },
  {
    type: "erp.payment.registered.v1",
    version: 1,
    description: "Un paiement a été enregistré et son identifiant ERP est disponible.",
    payloadFields: ["resource_type", "resource_id", "occurred_at"],
  },
  {
    type: "erp.webhook.test.v1",
    version: 1,
    description: "Événement sandbox explicitement déclenché par un administrateur.",
    payloadFields: ["subscription_id", "requested_at"],
  },
] as const;

export type WebhookEventType = typeof WEBHOOK_EVENT_REGISTRY[number]["type"];

export type OutboxProjectionInput = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date | string;
};

export type ProjectedWebhookEvent = {
  eventType: WebhookEventType;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export type SealedWebhookSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
};

export type ResolvedWebhookTarget = {
  address: string;
  family: 4 | 6;
};

export type WebhookEnvelope = {
  id: string;
  type: WebhookEventType;
  api_version: "v1";
  created_at: string;
  data: Record<string, unknown>;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isoDate(value: Date | string): string | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function isWebhookEventType(value: string): value is WebhookEventType {
  return WEBHOOK_EVENT_REGISTRY.some((entry) => entry.type === value);
}

export function projectOutboxEvent(input: OutboxProjectionInput): ProjectedWebhookEvent | null {
  const occurredAt = isoDate(input.created_at);
  if (!occurredAt) return null;

  const financeEventMap: Readonly<Record<string, WebhookEventType>> = {
    "FINANCE.INVOICE_ISSUED": "erp.invoice.issued.v1",
    "FINANCE.CREDIT_NOTE_ISSUED": "erp.credit-note.issued.v1",
    "FINANCE.PAYMENT_REGISTERED": "erp.payment.registered.v1",
  };
  const financeType = financeEventMap[input.event_type];
  if (financeType) {
    return {
      eventType: financeType,
      aggregateType: input.aggregate_type,
      aggregateId: input.aggregate_id,
      occurredAt,
      payload: {
        resource_type: input.aggregate_type,
        resource_id: input.aggregate_id,
        occurred_at: occurredAt,
      },
    };
  }

  if (input.event_type !== "REALTIME.DISPATCH") return null;
  const envelope = record(input.payload);
  const realtimeInput = record(envelope?.input);
  const payload = record(realtimeInput?.payload);
  if (realtimeInput?.event !== "entity:changed" || !payload) return null;
  const entityType = payload.entityType;
  const entityId = payload.entityId;
  const action = payload.action;
  const module = payload.module;
  const sourceOccurredAt = typeof payload.at === "string" ? isoDate(payload.at) : null;
  if (
    typeof entityType !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(entityType)
    || typeof entityId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entityId)
    || !["created", "updated", "deleted", "status_changed"].includes(String(action))
    || typeof module !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(module)
  ) return null;
  const eventOccurredAt = sourceOccurredAt ?? occurredAt;
  return {
    eventType: "erp.entity.changed.v1",
    aggregateType: entityType,
    aggregateId: entityId,
    occurredAt: eventOccurredAt,
    payload: {
      entity_type: entityType,
      entity_id: entityId,
      action,
      module,
      occurred_at: eventOccurredAt,
    },
  };
}

export function webhookSigningMessage(timestamp: string, deliveryId: string, rawBody: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${timestamp}.${deliveryId}.`, "utf8"),
    rawBody,
  ]);
}

export function signWebhookPayload(secret: string, timestamp: string, deliveryId: string, rawBody: Buffer): string {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(webhookSigningMessage(timestamp, deliveryId, rawBody))
    .digest("hex");
  return `v1=${signature}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  deliveryId: string,
  rawBody: Buffer,
  signatureHeader: string,
): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, deliveryId, rawBody));
  const actual = Buffer.from(signatureHeader);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString("base64url")}`;
}

export function parseWebhookEncryptionKey(raw: string | undefined): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  const encodings: Buffer[] = [];
  if (/^[0-9a-f]{64}$/i.test(value)) encodings.push(Buffer.from(value, "hex"));
  try {
    encodings.push(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
  return encodings.find((candidate) => candidate.length === 32) ?? null;
}

function endpointHostname(endpoint: URL): string {
  return endpoint.hostname.startsWith("[") && endpoint.hostname.endsWith("]")
    ? endpoint.hostname.slice(1, -1)
    : endpoint.hostname;
}

export function sealWebhookSecret(secret: string, key: Buffer): SealedWebhookSecret {
  if (key.length !== 32) throw new Error("WEBHOOK_ENCRYPTION_KEY_INVALID");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function unsealWebhookSecret(sealed: SealedWebhookSecret, key: Buffer): string {
  if (key.length !== 32) throw new Error("WEBHOOK_ENCRYPTION_KEY_INVALID");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && (b === 0 || b === 2 || b === 88))
    || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && octets[2] === 113);
}

function ipv6BigInt(address: string): bigint | null {
  const normalized = address.toLowerCase().split("%")[0];
  if (!normalized || !net.isIPv6(normalized)) return null;
  const [headRaw, tailRaw, extra] = normalized.split("::");
  if (extra !== undefined) return null;
  const parseParts = (raw: string | undefined): number[] | null => {
    if (!raw) return [];
    const output: number[] = [];
    for (const part of raw.split(":")) {
      if (part.includes(".")) {
        const octets = part.split(".").map(Number);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        output.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        const value = Number.parseInt(part, 16);
        if (!/^[0-9a-f]{1,4}$/.test(part) || !Number.isInteger(value)) return null;
        output.push(value);
      }
    }
    return output;
  };
  const head = parseParts(headRaw);
  const tail = parseParts(tailRaw);
  if (!head || !tail) return null;
  const compressed = normalized.includes("::");
  const missing = 8 - head.length - tail.length;
  if ((!compressed && missing !== 0) || (compressed && missing < 1)) return null;
  const groups = [...head, ...Array.from({ length: Math.max(0, missing) }, () => 0), ...tail];
  if (groups.length !== 8) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function inIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (prefix >> shift);
}

function privateIp(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (net.isIPv4(normalized)) return privateIpv4(normalized);
  const value = ipv6BigInt(normalized);
  if (value === null) return true;
  const mappedPrefix = 0xffffn;
  if ((value >> 32n) === mappedPrefix) {
    const ipv4 = Number(value & 0xffffffffn);
    return privateIpv4([
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join("."));
  }
  return inIpv6Prefix(value, 0n, 96)
    || inIpv6Prefix(value, 0xfc00n << 112n, 7)
    || inIpv6Prefix(value, 0xfe80n << 112n, 10)
    || inIpv6Prefix(value, 0xff00n << 112n, 8)
    || inIpv6Prefix(value, 0x64ff9bn << 96n, 96)
    || inIpv6Prefix(value, 0x64ff9b0001n << 80n, 48)
    || inIpv6Prefix(value, 0x100n << 112n, 64)
    || inIpv6Prefix(value, 0x20010db8n << 96n, 32);
}

export function validateWebhookEndpointSyntax(raw: string, environment = process.env): string {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("WEBHOOK_ENDPOINT_INVALID");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) throw new Error("WEBHOOK_ENDPOINT_INVALID");
  const sandboxPrivate = environment.NODE_ENV !== "production"
    && environment.CERP_WEBHOOK_SANDBOX_ALLOW_PRIVATE_HOSTS === "1";
  if (endpoint.protocol !== "https:" && !(sandboxPrivate && endpoint.protocol === "http:")) {
    throw new Error("WEBHOOK_ENDPOINT_HTTPS_REQUIRED");
  }
  const hostname = endpointHostname(endpoint);
  if (!hostname || endpoint.port === "0") throw new Error("WEBHOOK_ENDPOINT_INVALID");
  if (net.isIP(hostname) && privateIp(hostname) && !sandboxPrivate) {
    throw new Error("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
  }
  return endpoint.toString();
}

export async function assertWebhookTargetPublic(
  endpointRaw: string,
  environment = process.env,
): Promise<ResolvedWebhookTarget> {
  const endpoint = new URL(validateWebhookEndpointSyntax(endpointRaw, environment));
  const hostname = endpointHostname(endpoint);
  const sandboxPrivate = environment.NODE_ENV !== "production"
    && environment.CERP_WEBHOOK_SANDBOX_ALLOW_PRIVATE_HOSTS === "1";
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("WEBHOOK_ENDPOINT_DNS_EMPTY");
  if (!sandboxPrivate && addresses.some(({ address }) => privateIp(address))) {
    throw new Error("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
  }
  const selected = addresses[0];
  if (!selected || (selected.family !== 4 && selected.family !== 6)) throw new Error("WEBHOOK_ENDPOINT_DNS_EMPTY");
  return { address: selected.address, family: selected.family };
}

export function webhookRetryDelaySeconds(attempt: number): number {
  const normalized = Math.max(1, Math.min(8, Math.trunc(attempt)));
  return Math.min(3_600, 30 * (2 ** (normalized - 1)));
}

export function webhookEnvelope(params: {
  id: string;
  type: WebhookEventType;
  createdAt: Date | string;
  payload: Record<string, unknown>;
}): WebhookEnvelope {
  const createdAt = isoDate(params.createdAt);
  if (!createdAt) throw new Error("WEBHOOK_EVENT_TIMESTAMP_INVALID");
  return {
    id: params.id,
    type: params.type,
    api_version: "v1",
    created_at: createdAt,
    data: params.payload,
  };
}
