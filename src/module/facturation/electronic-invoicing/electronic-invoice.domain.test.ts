import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DGFiP_INVOICE_STATUSES,
  ElectronicInvoiceProviderRegistry,
  classifyProviderFailure,
  normalizeElectronicInvoiceProviderEvent,
  parseDGFiPInvoiceStatusCode,
  sanitizedProviderError,
  verifyHmacSha256Webhook,
  type ElectronicInvoiceProviderAdapter,
} from "./electronic-invoice.domain";

describe("DGFiP electronic invoice contract", () => {
  it("keeps the official V3.2 invoice lifecycle without fabricated statuses", () => {
    const officialFixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, "contract-fixtures", "dgfip-v3.2-invoice-statuses.json"), "utf8")
    ) as { statuses: Array<{ code: number; label: string; mandatory: boolean }> };
    expect(Object.keys(DGFiP_INVOICE_STATUSES).map(Number)).toEqual([
      200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213,
    ]);
    expect(DGFiP_INVOICE_STATUSES[200]).toEqual({ label: "Déposée", mandatory: true });
    expect(DGFiP_INVOICE_STATUSES[210].mandatory).toBe(true);
    expect(DGFiP_INVOICE_STATUSES[212].mandatory).toBe(true);
    expect(DGFiP_INVOICE_STATUSES[213].mandatory).toBe(true);
    expect(
      Object.entries(DGFiP_INVOICE_STATUSES).map(([code, value]) => ({ code: Number(code), ...value }))
    ).toEqual(officialFixture.statuses);
    expect(() => parseDGFiPInvoiceStatusCode("SENT")).toThrowError(/non reconnu/i);
  });

  it("uses bounded retry decisions and respects rate-limit hints", () => {
    expect(classifyProviderFailure({ httpStatus: 429, attempt: 2, retryAfterSeconds: 90 })).toEqual({
      retryable: true,
      reason: "RATE_LIMIT",
      delaySeconds: 90,
    });
    expect(classifyProviderFailure({ httpStatus: 503, attempt: 3 })).toEqual({
      retryable: true,
      reason: "TRANSIENT",
      delaySeconds: 120,
    });
    expect(classifyProviderFailure({ httpStatus: 422, attempt: 1 })).toEqual({
      retryable: false,
      reason: "PERMANENT",
      delaySeconds: null,
    });
  });

  it("redacts credentials and personal addresses from provider errors", () => {
    expect(
      sanitizedProviderError({
        code: "PA_422",
        message: "Bearer secret-token contact buyer@example.test?token=secret-value",
      })
    ).toEqual({
      code: "PA_422",
      message: "Bearer [REDACTED] contact [EMAIL_REDACTED]?token=[REDACTED]",
    });
  });

  it("verifies signed webhook bytes and rejects replay outside the time window", () => {
    const body = Buffer.from('{"event_id":"evt-1"}');
    const timestamp = 1_786_684_800;
    const signature = crypto.createHmac("sha256", "test-secret").update(`${timestamp}.`).update(body).digest("hex");
    expect(
      verifyHmacSha256Webhook({
        body,
        secret: "test-secret",
        signatureHeader: `t=${timestamp},v1=${signature}`,
        nowEpochSeconds: timestamp + 10,
      })
    ).toMatchObject({ timestamp });
    expect(() =>
      verifyHmacSha256Webhook({
        body,
        secret: "test-secret",
        signatureHeader: `t=${timestamp},v1=${signature}`,
        nowEpochSeconds: timestamp + 301,
      })
    ).toThrowError(/expiré/i);
  });

  it("does not resolve an unregistered provider and accepts a contract adapter", () => {
    const registry = new ElectronicInvoiceProviderRegistry();
    expect(() => registry.resolve("missing")).toThrowError(/Plateforme Agréée réelle/i);
    const adapter = {
      code: "contract-pa",
      environment: "sandbox",
      supportedFormats: ["UBL"],
      prepare: async () => ({
        format: "UBL",
        filename: "invoice.xml",
        contentType: "application/xml",
        content: Buffer.from("<Invoice/>") ,
        attachments: [],
      }),
      submit: async () => ({
        providerDocumentId: "provider-1",
        providerRequestId: "request-1",
        acceptedAt: "2026-08-14T10:00:00.000Z",
        statusCode: 200,
        filingProofReference: "proof-1",
        filingProofSha256: "a".repeat(64),
      }),
      retrieve: async () => {
        throw new Error("not used");
      },
      verifyAndParseWebhook: async () => {
        throw new Error("not used");
      },
    } satisfies ElectronicInvoiceProviderAdapter;
    registry.register(adapter);
    expect(registry.resolve("contract-pa")).toBe(adapter);
  });

  it("normalizes provider events and rejects unsafe storage references", () => {
    const event = normalizeElectronicInvoiceProviderEvent({
      providerEventId: "evt-42",
      providerDocumentId: "doc-42",
      direction: "INBOUND",
      documentType: "INVOICE",
      format: "CII",
      invoiceId: null,
      creditNoteId: null,
      documentSha256: "a".repeat(64),
      contentStorageReference: "ged/quarantine/doc-42.xml",
      attachments: [{
        filename: "annexe.pdf",
        contentType: "application/pdf",
        contentSha256: "b".repeat(64),
        storageReference: "ged/quarantine/annexe-42.pdf",
      }],
      statusCode: 213,
      occurredAt: "2026-08-14T10:00:00+02:00",
      rejectionCode: "REJ_SEMAN",
      rejectionMessage: "Bearer raw-token compta@example.test",
      filingProofReference: null,
      filingProofSha256: null,
    });
    expect(event.occurredAt).toBe("2026-08-14T08:00:00.000Z");
    expect(event.rejectionMessage).not.toMatch(/raw-token|compta@example\.test/);
    expect(() => normalizeElectronicInvoiceProviderEvent({
      ...event,
      contentStorageReference: "https://storage.invalid/doc.xml?token=secret",
    })).toThrowError(/stockage invalide/i);
    expect(() => normalizeElectronicInvoiceProviderEvent({
      ...event,
      attachments: [null] as never,
    })).toThrowError(/pièce jointe invalides/i);
  });
});
