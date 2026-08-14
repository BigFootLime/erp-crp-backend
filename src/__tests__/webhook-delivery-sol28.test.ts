import http from "node:http";
import type { AddressInfo } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  target: vi.fn(),
}));

vi.mock("../module/integrations/webhooks/webhook.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/integrations/webhooks/webhook.repository")>();
  return {
    ...actual,
    repoProjectWebhookOutboxBatch: (...args: unknown[]) => mocks.project(...args),
    repoClaimWebhookDelivery: (...args: unknown[]) => mocks.claim(...args),
    repoCompleteWebhookDelivery: (...args: unknown[]) => mocks.complete(...args),
  };
});

vi.mock("../module/integrations/webhooks/webhook.domain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/integrations/webhooks/webhook.domain")>();
  return { ...actual, assertWebhookTargetPublic: (...args: unknown[]) => mocks.target(...args) };
});

import {
  sealWebhookSecret,
  verifyWebhookSignature,
} from "../module/integrations/webhooks/webhook.domain";
import { processNextWebhookDelivery } from "../module/integrations/webhooks/webhook.service";

const key = Buffer.alloc(32, 9);
const secret = "whsec_contract_test_secret";

function claim() {
  return {
    deliveryId: "11111111-1111-4111-8111-111111111111",
    subscriptionId: "22222222-2222-4222-8222-222222222222",
    endpointUrl: "https://example.com/webhook",
    secret: sealWebhookSecret(secret, key),
    secretVersion: 2,
    eventId: "33333333-3333-4333-8333-333333333333",
    eventType: "erp.invoice.issued.v1",
    eventCreatedAt: "2026-08-14T10:00:00.000Z",
    payload: { resource_type: "FACTURE", resource_id: "87", occurred_at: "2026-08-14T10:00:00.000Z" },
    attemptCount: 0,
    leaseToken: "44444444-4444-4444-8444-444444444444",
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CERP_WEBHOOK_SECRET_ENCRYPTION_KEY = key.toString("base64");
  mocks.project.mockResolvedValue(1);
  mocks.claim.mockResolvedValue(claim());
  mocks.complete.mockResolvedValue(undefined);
  mocks.target.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("SOL-28 outbound delivery", () => {
  it("pins the validated address for the network connection", async () => {
    let receivedHost = "";
    let receivedBody = Buffer.alloc(0);
    const server = http.createServer((request, response) => {
      receivedHost = request.headers.host ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedBody = Buffer.concat(chunks);
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      mocks.claim.mockResolvedValue({ ...claim(), endpointUrl: `http://receiver.example.invalid:${port}/hook` });
      mocks.target.mockResolvedValue({ address: "127.0.0.1", family: 4 });
      await expect(processNextWebhookDelivery()).resolves.toBe(true);
      expect(receivedHost).toBe(`receiver.example.invalid:${port}`);
      expect(JSON.parse(receivedBody.toString("utf8"))).toMatchObject({ id: claim().eventId, type: claim().eventType });
      expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "DELIVERED", httpStatus: 204 }));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("sends a signed, versioned envelope and records success without response content", async () => {
    let sentBody = Buffer.alloc(0);
    let sentHeaders = new Headers();
    const fetchStub = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      sentBody = Buffer.from(init?.body as Uint8Array);
      sentHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    });
    await expect(processNextWebhookDelivery(fetchStub)).resolves.toBe(true);
    const timestamp = sentHeaders.get("cerp-webhook-timestamp") ?? "";
    const signature = sentHeaders.get("cerp-webhook-signature") ?? "";
    expect(sentHeaders.get("cerp-webhook-id")).toBe(claim().deliveryId);
    expect(sentHeaders.get("cerp-webhook-secret-version")).toBe("2");
    expect(verifyWebhookSignature(secret, timestamp, claim().deliveryId, sentBody, signature)).toBe(true);
    expect(JSON.parse(sentBody.toString("utf8"))).toEqual({
      id: claim().eventId,
      type: claim().eventType,
      api_version: "v1",
      created_at: claim().eventCreatedAt,
      data: claim().payload,
    });
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ outcome: "DELIVERED", httpStatus: 204, errorCode: null }));
  });

  it("schedules a bounded exponential retry for a transient provider failure", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 503 }));
    await processNextWebhookDelivery(fetchStub);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "RETRY",
      httpStatus: 503,
      errorCode: "WEBHOOK_HTTP_503",
      retryDelaySeconds: 30,
      disableSubscription: false,
    }));
  });

  it("dead-letters and disables an endpoint explicitly gone", async () => {
    const fetchStub = vi.fn(async () => new Response(null, { status: 410 }));
    await processNextWebhookDelivery(fetchStub);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "DEAD_LETTER",
      httpStatus: 410,
      errorCode: "WEBHOOK_HTTP_410",
      disableSubscription: true,
    }));
  });
});
