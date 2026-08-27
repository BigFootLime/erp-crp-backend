import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({
  applyEvent: vi.fn(),
  claim: vi.fn(),
  getConnection: vi.fn(),
  getState: vi.fn(),
  queue: vi.fn(),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
}));

vi.mock("./electronic-invoice.repository", () => ({
  repoApplyElectronicInvoiceProviderEvent: repository.applyEvent,
  repoClaimElectronicInvoice: repository.claim,
  repoGetElectronicInvoiceConnection: repository.getConnection,
  repoGetElectronicInvoiceState: repository.getState,
  repoQueueElectronicInvoice: repository.queue,
  repoRecordElectronicInvoiceFailure: repository.recordFailure,
  repoRecordElectronicInvoiceSuccess: repository.recordSuccess,
}));

vi.mock("../../../shared/observability/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import type { ElectronicInvoiceProviderAdapter } from "./electronic-invoice.domain";
import {
  electronicInvoiceProviderRegistry,
  svcProcessNextElectronicInvoice,
} from "./electronic-invoice.service";

const prepare = vi.fn();
const submit = vi.fn();

const adapter = {
  code: "contract-pa",
  environment: "sandbox",
  supportedFormats: ["UBL"],
  prepare,
  diagnose: vi.fn(),
  submit,
  retrieve: vi.fn(),
  verifyAndParseWebhook: vi.fn(),
} satisfies ElectronicInvoiceProviderAdapter;

const claim = {
  processingToken: "8e9bf2a1-e2ce-4af7-8310-e77bbef77d19",
  providerAdapterKey: "contract-pa",
  environment: "sandbox" as const,
  state: {
    id: "b375d1d7-7d5b-42de-9bb4-c6ac61b21b73",
    invoice_id: 42,
    credit_note_id: null,
    direction: "OUTBOUND" as const,
    document_type: "INVOICE" as const,
    format: "UBL" as const,
    provider_code: "qualified-pa",
    provider_document_id: null,
    source_sha256: "a".repeat(64),
    content_sha256: null,
    external_status: null,
    external_status_at: null,
    filing_proof_reference: null,
    filing_proof_sha256: null,
    retry_count: 0,
    next_retry_at: "2026-08-14T12:00:00.000Z",
    last_error: null,
    correlation_id: "d05af0a2-d278-49da-8330-3bb115887fcf",
    created_at: "2026-08-14T12:00:00.000Z",
    updated_at: "2026-08-14T12:00:00.000Z",
  },
  source: {
    invoiceId: 42,
    creditNoteId: null,
    documentType: "INVOICE" as const,
    legalNumber: "FAC-2026-00042",
    issueDate: "2026-08-14",
    dueDate: "2026-09-13",
    currency: "EUR",
    issuerSnapshot: { siren: "123456789" },
    customerSnapshot: { siret: "12345678900012" },
    regulatorySnapshot: {
      specVersion: "DGFiP-FE-V3.2-2026-04-30",
      billingFrameCatalogVersion: "AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30",
      billingFrameCode: "B1",
      operationCategory: "GOODS",
      transactionScope: "FR_PRIVATE_B2B",
      sellerElectronicAddress: {
        scheme: "0225",
        value: "seller-routing-42",
        directoryEntryId: "seller-directory-42",
        verifiedAt: "2026-08-14T10:00:00.000Z",
      },
      buyerElectronicAddress: {
        scheme: "0225",
        value: "buyer-routing-42",
        directoryEntryId: "buyer-directory-42",
        verifiedAt: "2026-08-14T10:00:00.000Z",
      },
      buyerSiren: "123456789",
      deliveryAddress: null,
    },
    lines: [{ quantity: "1", total_ex_tax: "100.00" }],
    totals: { net: "100.00", tax: "20.00", gross: "120.00" },
  },
};

describe("electronic invoice worker", () => {
  beforeAll(() => {
    electronicInvoiceProviderRegistry.register(adapter);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    repository.claim.mockResolvedValue(claim);
    prepare.mockResolvedValue({
      format: "UBL",
      filename: "FAC-2026-00042.xml",
      contentType: "application/xml",
      content: Buffer.from("<Invoice>FAC-2026-00042</Invoice>"),
      attachments: [],
    });
    submit.mockResolvedValue({
      providerDocumentId: "provider-document-42",
      providerRequestId: "provider-request-42",
      acceptedAt: "2026-08-14T12:01:00.000Z",
      statusCode: 200,
      filingProofReference: "provider-proof-42",
      filingProofSha256: "b".repeat(64),
    });
  });

  it("does nothing when the transactional queue has no claim", async () => {
    repository.claim.mockResolvedValueOnce(null);
    await expect(svcProcessNextElectronicInvoice()).resolves.toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it("uses a stable provider idempotency key and records the exact content hash", async () => {
    await expect(svcProcessNextElectronicInvoice()).resolves.toBe(true);

    expect(submit).toHaveBeenCalledWith(expect.objectContaining({
      localDocumentId: claim.state.id,
      idempotencyKey: `cerp-einvoice-${claim.state.id}`,
      correlationId: claim.state.correlation_id,
      contentSha256: "25137e8766c023406f4720d41970e8fead687b48285d16c8632000c91e8bcfa8",
    }));
    expect(repository.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      documentId: claim.state.id,
      processingToken: claim.processingToken,
      contentSha256: "25137e8766c023406f4720d41970e8fead687b48285d16c8632000c91e8bcfa8",
    }));
    expect(repository.recordFailure).not.toHaveBeenCalled();
  });

  it("backs off a rate limit and strips tokens and email addresses from persisted errors", async () => {
    submit.mockRejectedValueOnce(Object.assign(
      new Error("Bearer raw-token contact compta@example.test?token=secret"),
      { code: "PA_RATE_LIMIT", httpStatus: 429, retryAfterSeconds: 90 }
    ));

    await expect(svcProcessNextElectronicInvoice()).resolves.toBe(true);

    expect(repository.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      documentId: claim.state.id,
      retryable: true,
      delaySeconds: 90,
      httpStatus: 429,
      errorCode: "PA_RATE_LIMIT",
      errorMessage: expect.not.stringMatching(/raw-token|compta@example\.test|secret/),
    }));
    expect(repository.recordSuccess).not.toHaveBeenCalled();
  });
});
