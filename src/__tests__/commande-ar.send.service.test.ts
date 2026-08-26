import crypto from "node:crypto";
import { describe, expect, it, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  finalize: vi.fn(),
  markFailed: vi.fn(),
  sendEmail: vi.fn(),
  findArchive: vi.fn(),
  readOfficialPdf: vi.fn(),
}));

vi.mock("../module/commande-client/repository/commande-ar.repository", () => ({
  repoClaimCommandeArSend: mocks.claim,
  repoFinalizeCommandeArSend: mocks.finalize,
  repoMarkCommandeArFailed: mocks.markFailed,
  repoFindCommandeArOfficialArchiveId: mocks.findArchive,
  repoResolveCommandeArOfficialArchive: vi.fn(),
  repoLoadCommandeArGenerationData: vi.fn(),
  repoCreateCommandeArDraft: vi.fn(),
  repoFindReusableCommandeArDraft: vi.fn(),
  repoListCommandeArDrafts: vi.fn(),
  repoReserveCommandeArVersion: vi.fn(),
  buildCommandeArRecipientSuggestions: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { connect: vi.fn(), query: vi.fn() } }));
vi.mock("../shared/email/resend.service", () => ({ sendTransactionalEmail: mocks.sendEmail }));
vi.mock("../shared/authoritative-documents/authoritative-document.service", () => ({
  readOfficialPdfBytes: mocks.readOfficialPdf,
  getOfficialDocumentGenerationEnvelope: vi.fn(),
  getOfficialPdfDto: vi.fn(),
  recordOfficialPdfPrintIntent: vi.fn(),
}));

import { svcSendCommandeAr } from "../module/commande-client/services/commande-ar.service";

const AR_ID = "11111111-1111-1111-1111-111111111111";
const DOCUMENT_ID = "22222222-2222-2222-2222-222222222222";
const PDF = Buffer.from("%PDF-AR-v1");
const PDF_HASH = crypto.createHash("sha256").update(PDF).digest("hex");

function claimedDraft() {
  return {
    ar_id: AR_ID,
    commande_id: 42,
    document_id: DOCUMENT_ID,
    document_name: "AR-00000001-v1.pdf",
    reference: "AR-00000001-v1",
    series_number: 1,
    version_number: 1,
    subject: "Accusé de réception de votre commande CMD-42 — AR-00000001-v1",
    body_text: null,
    generated_at: "2026-08-26T10:00:00.000Z",
    generated_by: 7,
    status: "SENDING" as const,
    sent_at: null,
    send_started_at: "2026-08-26T10:01:00.000Z",
    recipient_emails: [],
    recipient_contact_ids: [],
    content_fingerprint: "a".repeat(64),
    content_snapshot: {
      schema_version: 1,
      header: {
        numero: "CMD-42",
        customer_reference: "PO-42",
        statut: "AR_PRET",
        date_commande: "2026-08-20",
        commentaire: null,
        total_ht: 10,
        total_ttc: 12,
        client_company_name: "Client SA",
        client_email: "client@example.test",
        client_phone: null,
        bill_address: {},
        delivery_address: {},
      },
      lines: [],
      allocations: [],
    },
    pdf_sha256: PDF_HASH,
    send_idempotency_key: "commande-ar:test",
    send_payload_fingerprint: null,
    preview_path: `/commandes/42/documents/${DOCUMENT_ID}/file`,
  };
}

const sendBody = {
  ar_id: AR_ID,
  recipient_emails: ["client@example.test"],
  recipient_contact_ids: [],
  message: "Message <personnalisé>",
  idempotency_key: "commande-ar:test",
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.findArchive.mockResolvedValue("44444444-4444-4444-8444-444444444444");
  mocks.readOfficialPdf.mockResolvedValue({ filename: "AR-00000001-v1.pdf", bytes: PDF });
  mocks.markFailed.mockResolvedValue(undefined);
  mocks.claim.mockResolvedValue({
    kind: "claimed",
    draft: claimedDraft(),
    lock_token: "33333333-3333-3333-3333-333333333333",
    idempotency_key: "commande-ar:test",
    contacts: [],
  });
  mocks.finalize.mockResolvedValue({
    result: {
      ar_id: AR_ID,
      commande_id: 42,
      document_id: DOCUMENT_ID,
      reference: "AR-00000001-v1",
      status: "AR_ENVOYE",
      sent_at: "2026-08-26T10:02:00.000Z",
      recipient_emails: ["client@example.test"],
      email_provider_id: "re_123",
    },
    notifications: [],
  });
});

describe("svcSendCommandeAr", () => {
  it("sends the previewed PDF and only advances workflow after provider success", async () => {
    mocks.sendEmail.mockResolvedValue({ ok: true, id: "re_123" });

    const result = await svcSendCommandeAr({ commande_id: 42, user_id: 7, body: sendBody });

    expect(result.status).toBe("AR_ENVOYE");
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "commande-ar:test",
        subject: "Accusé de réception de votre commande CMD-42 — AR-00000001-v1",
        attachments: [expect.objectContaining({ filename: "AR-00000001-v1.pdf", content: PDF })],
      })
    );
    const finalization = mocks.finalize.mock.calls[0]?.[0];
    expect(finalization.sent_email_text.indexOf("Message <personnalisé>")).toBeLessThan(
      finalization.sent_email_text.indexOf("Cordialement,")
    );
    expect(finalization.sent_email_html).toContain("Message &lt;personnalisé&gt;");
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("records provider failure without finalizing workflow state", async () => {
    mocks.sendEmail.mockResolvedValue({ ok: false, skipped: true });

    await expect(svcSendCommandeAr({ commande_id: 42, user_id: 7, body: sendBody })).rejects.toMatchObject({
      code: "COMMANDE_AR_SEND_FAILED",
      status: 503,
    });

    expect(mocks.markFailed).toHaveBeenCalledWith(expect.objectContaining({ ar_id: AR_ID }));
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("returns an already-sent version without calling the provider a second time", async () => {
    mocks.claim.mockResolvedValue({
      kind: "already_sent",
      result: {
        ar_id: AR_ID,
        commande_id: 42,
        document_id: DOCUMENT_ID,
        reference: "AR-00000001-v1",
        status: "AR_ENVOYE",
        sent_at: "2026-08-26T10:02:00.000Z",
        recipient_emails: ["client@example.test"],
        email_provider_id: "re_123",
        already_sent: true,
      },
    });

    const result = await svcSendCommandeAr({ commande_id: 42, user_id: 7, body: sendBody });

    expect(result.already_sent).toBe(true);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
