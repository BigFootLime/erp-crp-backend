import { describe, expect, it } from "vitest";

import {
  WEBHOOK_EVENT_REGISTRY,
  generateWebhookSecret,
  parseWebhookEncryptionKey,
  projectOutboxEvent,
  sealWebhookSecret,
  signWebhookPayload,
  unsealWebhookSecret,
  validateWebhookEndpointSyntax,
  verifyWebhookSignature,
  webhookRetryDelaySeconds,
} from "../module/integrations/webhooks/webhook.domain";

describe("SOL-28 webhook domain", () => {
  it("projects only the non-sensitive realtime entity contract", () => {
    const projected = projectOutboxEvent({
      id: "11111111-1111-4111-8111-111111111111",
      aggregate_type: "REALTIME",
      aggregate_id: "CLIENT:42",
      event_type: "REALTIME.DISPATCH",
      created_at: "2026-08-14T10:00:00.000Z",
      payload: {
        schemaVersion: 1,
        eventId: "22222222-2222-4222-8222-222222222222",
        input: {
          event: "entity:changed",
          payload: {
            entityType: "CLIENT",
            entityId: "42",
            action: "updated",
            module: "clients",
            at: "2026-08-14T09:59:59.000Z",
            invalidateKeys: ["clients"],
            password: "must-not-leak",
          },
          targets: [{ scope: "user", userId: 7 }],
          streamId: "user:7",
        },
      },
    });
    expect(projected).toMatchObject({
      eventType: "erp.entity.changed.v1",
      aggregateType: "CLIENT",
      aggregateId: "42",
      payload: {
        entity_type: "CLIENT",
        entity_id: "42",
        action: "updated",
        module: "clients",
      },
    });
    expect(JSON.stringify(projected)).not.toContain("password");
    expect(JSON.stringify(projected)).not.toContain("userId");
    expect(JSON.stringify(projected)).not.toContain("invalidateKeys");
  });

  it("projects the selected finance events without copying their payload", () => {
    const projected = projectOutboxEvent({
      id: "11111111-1111-4111-8111-111111111111",
      aggregate_type: "FACTURE",
      aggregate_id: "87",
      event_type: "FINANCE.INVOICE_ISSUED",
      created_at: "2026-08-14T10:00:00.000Z",
      payload: { client_email: "secret@example.invalid", amount: "999.00" },
    });
    expect(projected?.eventType).toBe("erp.invoice.issued.v1");
    expect(projected?.payload).toEqual({
      resource_type: "FACTURE",
      resource_id: "87",
      occurred_at: "2026-08-14T10:00:00.000Z",
    });
  });

  it("signs timestamp, delivery id and exact raw bytes and detects replay tampering", () => {
    const secret = generateWebhookSecret();
    const body = Buffer.from('{"value":1}', "utf8");
    const signature = signWebhookPayload(secret, "1786692000", "33333333-3333-4333-8333-333333333333", body);
    expect(verifyWebhookSignature(secret, "1786692000", "33333333-3333-4333-8333-333333333333", body, signature)).toBe(true);
    expect(verifyWebhookSignature(secret, "1786692001", "33333333-3333-4333-8333-333333333333", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, "1786692000", "44444444-4444-4444-8444-444444444444", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, "1786692000", "33333333-3333-4333-8333-333333333333", Buffer.from('{"value":2}'), signature)).toBe(false);
  });

  it("encrypts subscription secrets with AES-GCM and refuses another key", () => {
    const key = Buffer.alloc(32, 7);
    const secret = generateWebhookSecret();
    const sealed = sealWebhookSecret(secret, key);
    expect(unsealWebhookSecret(sealed, key)).toBe(secret);
    expect(() => unsealWebhookSecret(sealed, Buffer.alloc(32, 8))).toThrow();
    expect(parseWebhookEncryptionKey(key.toString("base64"))).toEqual(key);
    expect(parseWebhookEncryptionKey("invalid")).toBeNull();
  });

  it("blocks insecure/private targets in production and permits explicit local sandbox only", () => {
    const production = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
    expect(() => validateWebhookEndpointSyntax("http://example.com/hook", production)).toThrow("WEBHOOK_ENDPOINT_HTTPS_REQUIRED");
    expect(() => validateWebhookEndpointSyntax("https://127.0.0.1/hook", production)).toThrow("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
    expect(() => validateWebhookEndpointSyntax("https://169.254.169.254/latest", production)).toThrow("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
    expect(() => validateWebhookEndpointSyntax("https://198.18.0.1/hook", production)).toThrow("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
    expect(() => validateWebhookEndpointSyntax("https://[::ffff:172.16.0.1]/hook", production)).toThrow("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
    expect(() => validateWebhookEndpointSyntax("https://[2001:db8::1]/hook", production)).toThrow("WEBHOOK_ENDPOINT_PRIVATE_NETWORK_FORBIDDEN");
    expect(validateWebhookEndpointSyntax("https://example.com/hook", production)).toBe("https://example.com/hook");
    const sandbox = { NODE_ENV: "test", CERP_WEBHOOK_SANDBOX_ALLOW_PRIVATE_HOSTS: "1" } as NodeJS.ProcessEnv;
    expect(validateWebhookEndpointSyntax("http://127.0.0.1:9010/hook", sandbox)).toBe("http://127.0.0.1:9010/hook");
  });

  it("uses bounded exponential retries and a unique versioned registry", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(webhookRetryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600]);
    const types = WEBHOOK_EVENT_REGISTRY.map((entry) => entry.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.every((type) => type.endsWith(".v1"))).toBe(true);
  });
});
