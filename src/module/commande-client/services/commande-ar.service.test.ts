import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  sendEmail: vi.fn(),
  authorizeGeneration: vi.fn(),
  abortClaim: vi.fn(),
  claimSend: vi.fn(),
  finalizeSend: vi.fn(),
  markFailed: vi.fn(),
  readArchived: vi.fn(),
  findArchive: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: mocks.readFile },
}));

vi.mock("../../../config/database", () => ({
  default: { connect: vi.fn() },
}));
vi.mock("../../../shared/realtime/realtime.service", () => ({
  emitAppNotificationCreated: vi.fn(),
  emitEntityChanged: vi.fn(),
}));
vi.mock("../../../shared/email/resend.service", () => ({
  sendTransactionalEmail: mocks.sendEmail,
}));
vi.mock("../../../shared/documents/issuer-identity.repository", () => ({
  readIssuerParty: vi.fn(),
}));
vi.mock("../../../shared/authoritative-documents/authoritative-document.service", () => ({
  getOfficialDocumentGenerationEnvelope: vi.fn(),
  getOfficialPdfDto: vi.fn(),
  readOfficialPdfBytes: mocks.readArchived,
  recordOfficialPdfPrintIntent: vi.fn(),
  officialDocumentGenerationEnvelope: vi.fn(),
}));
vi.mock("../repository/commande-ar.repository", () => ({
  buildCommandeArRecipientSuggestions: vi.fn(),
  repoAbortCommandeArSendClaim: mocks.abortClaim,
  repoAuthorizeCommandeArGeneration: mocks.authorizeGeneration,
  repoClaimCommandeArSend: mocks.claimSend,
  repoCreateCommandeArDraft: vi.fn(),
  repoFinalizeCommandeArSend: mocks.finalizeSend,
  repoFindCommandeArOfficialArchiveId: mocks.findArchive,
  repoGetCommandeArDraft: vi.fn(),
  repoLoadCommandeArGenerationData: vi.fn(),
  repoMarkCommandeArFailed: mocks.markFailed,
}));

import { buildCommandeArPdfBuffer, svcSendCommandeAr } from "./commande-ar.service";

const WINANSI = new TextDecoder("windows-1252");

function drawnPages(bytes: Buffer): string[] {
  const decodeOperands = (operands: string): string =>
    [...operands.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)]
      .map((match) =>
        match[1] !== undefined
          ? WINANSI.decode(Buffer.from(match[1].replace(/\s+/g, ""), "hex"))
          : match[2].replace(/\\([()\\])/g, "$1")
      )
      .join("");

  const pages: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = bytes.indexOf("stream", cursor);
    if (start < 0) break;
    let from = start + "stream".length;
    if (bytes[from] === 0x0d) from += 1;
    if (bytes[from] === 0x0a) from += 1;
    const end = bytes.indexOf("endstream", from);
    if (end < 0) break;
    cursor = end + "endstream".length;

    let content: string;
    try {
      content = inflateSync(bytes.subarray(from, end)).toString("latin1");
    } catch {
      continue;
    }
    if (!content.includes("BT")) continue;
    pages.push(
      [
        ...[...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((match) =>
          decodeOperands(match[1])
        ),
        ...[
          ...content.matchAll(
            /(<[0-9a-fA-F\s]*>|\((?:\\.|[^\\)])*\))\s*Tj/g
          ),
        ].map((match) => decodeOperands(match[1])),
      ].join("\n")
    );
  }
  return pages;
}

const ISSUER = {
  company_name: "CROIX ROUSSE PRECISION",
  legal_form: "SARL",
  share_capital: "21000.00",
  share_capital_currency: "EUR",
  rcs_city: "Bourg-en-Bresse",
  rcs_number: "380 569 012",
  siret: "380 569 012 00020",
  vat_number: "FR73 380 569 012",
  late_penalty_rate: "12.500",
  late_penalty_basis: "ANNUEL",
  recovery_indemnity: "40.00",
  early_discount_rate: "1.500",
  early_discount_basis: "MENSUEL",
  vat_on_receipts: true,
  retention_of_title: "Propriété réservée jusqu'au paiement intégral.",
  legal_mentions_version: 1,
};

const SEND_BODY = {
  ar_id: "11111111-1111-4111-8111-111111111111",
  recipient_emails: ["new-request@example.test"],
  recipient_contact_ids: [],
  email_body: "Bonjour Client,\n\nVeuillez trouver ci-joint votre accusé de réception relu.",
};

const ARCHIVED_PDF = Buffer.from("pdf");

const GENERATED_DRAFT = {
  ar_id: SEND_BODY.ar_id,
  commande_id: 123,
  document_id: "22222222-2222-4222-8222-222222222222",
  document_name: "AR-123.pdf",
  reference: "AR-00000123-v1",
  series_number: 123,
  version_number: 1,
  subject: "AR commande 123",
  body_text: null,
  generated_at: "2026-08-04T08:00:00.000Z",
  generated_by: 7,
  status: "GENERATED" as const,
  sent_at: null,
  recipient_emails: [],
  email_provider_id: null,
  content_fingerprint: "a".repeat(64),
  content_snapshot: {
    schema_version: 1,
    header: { numero: "CMD-123", customer_reference: "PO-123" },
    lines: [],
    allocations: [],
  },
  pdf_sha256: createHash("sha256").update(ARCHIVED_PDF).digest("hex"),
  send_idempotency_key: "commande-ar:test",
  send_payload_fingerprint: null,
  preview_path: "/commandes/123/documents/22222222-2222-4222-8222-222222222222/file",
};

describe("envoi AR claimé avant effet externe", () => {
  it.each([
    [403, "COMMAND_CHECKPOINT_FORBIDDEN"],
    [409, "COMMAND_AR_SEND_NOT_ALLOWED"],
    [409, "COMMAND_AR_STATUS_INVALID"],
  ])("does not call the email provider when the atomic claim rejects (%s %s)", async (status, code) => {
    mocks.claimSend.mockRejectedValueOnce(Object.assign(new Error(code), { status, code }));

    await expect(svcSendCommandeAr({
      commande_id: 123,
      user_id: 7,
      user_role: "Secretaire",
      body: SEND_BODY,
    })).rejects.toMatchObject({ status, code });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("lets only the claimed concurrent request call the provider and returns the persisted SENT replay", async () => {
    const claim = {
      kind: "claimed" as const,
      draft: GENERATED_DRAFT,
      lock_token: "33333333-3333-4333-8333-333333333333",
      idempotency_key: "commande-ar:test",
      contacts: [],
    };
    const persistedReplay = {
      ...GENERATED_DRAFT,
      status: "SENT" as const,
      sent_at: "2026-08-04T08:05:00.000Z",
      recipient_emails: ["persisted@example.test"],
      email_provider_id: "provider-persisted",
    };
    mocks.claimSend
      .mockResolvedValueOnce(claim)
      .mockResolvedValueOnce({
        kind: "already_sent",
        result: {
          ar_id: persistedReplay.ar_id,
          commande_id: persistedReplay.commande_id,
          document_id: persistedReplay.document_id,
          reference: persistedReplay.reference,
          status: "AR_ENVOYE",
          sent_at: persistedReplay.sent_at,
          recipient_emails: persistedReplay.recipient_emails,
          email_provider_id: persistedReplay.email_provider_id,
          already_sent: true,
        },
      });
    mocks.findArchive
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("33333333-3333-4333-8333-333333333333");
    mocks.readArchived.mockResolvedValueOnce({ bytes: ARCHIVED_PDF, filename: "AR-123-officiel.pdf", sha256: createHash("sha256").update(ARCHIVED_PDF).digest("hex") });
    mocks.sendEmail.mockResolvedValueOnce({ ok: true, id: "provider-first" });
    mocks.finalizeSend.mockResolvedValueOnce({
      result: {
        ar_id: SEND_BODY.ar_id,
        commande_id: 123,
        document_id: GENERATED_DRAFT.document_id,
        reference: GENERATED_DRAFT.reference,
        status: "AR_ENVOYE",
        sent_at: "2026-08-04T08:05:00.000Z",
        recipient_emails: SEND_BODY.recipient_emails,
        email_provider_id: "provider-first",
      },
      notifications: [],
    });

    const [first, replay] = await Promise.all([
      svcSendCommandeAr({ commande_id: 123, user_id: 7, user_role: "Secretaire", body: SEND_BODY }),
      svcSendCommandeAr({ commande_id: 123, user_id: 7, user_role: "Secretaire", body: SEND_BODY }),
    ]);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(mocks.findArchive).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      text: SEND_BODY.email_body,
      html: expect.stringContaining("votre accusé de réception relu"),
    }));
    expect(mocks.readArchived).toHaveBeenCalledWith(expect.objectContaining({
      entityType: "commande-client",
      entityId: "123",
      documentKind: "CUSTOMER_ORDER_ACKNOWLEDGEMENT",
      archiveId: "33333333-3333-4333-8333-333333333333",
      eventType: "AUTHORITATIVE_PDF_SENT",
    }));
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(first.email_provider_id).toBe("provider-first");
    expect(replay).toMatchObject({
      recipient_emails: ["persisted@example.test"],
      email_provider_id: "provider-persisted",
    });
  });
});

describe("accusé de réception — mentions légales", () => {
  it("uses the CERP document footer and repeats legal mentions on every page", async () => {
    const bytes = await buildCommandeArPdfBuffer({
      draftNumber: "CC-2026-0042",
      companyName: "ABB FRANCE",
      dateCommande: "2026-07-20",
      generatedAt: new Date("2026-07-29T10:00:00.000Z"),
      statut: "PLANIFIEE",
      totalHt: 12_000,
      totalTtc: 14_400,
      commentaire: "Merci de vérifier les délais confirmés.",
      clientEmail: "achats@example.test",
      clientPhone: "01 23 45 67 89",
      billAddress: {
        name: "ABB FRANCE",
        street: "Rue de la Commande",
        house_number: "12",
        postal_code: "69000",
        city: "LYON",
        country: "France",
      },
      deliveryAddress: {
        name: "ABB FRANCE — Réception",
        street: "Rue de la Livraison",
        house_number: "4",
        postal_code: "69000",
        city: "LYON",
        country: "France",
      },
      lines: Array.from({ length: 45 }, (_, index) => ({
        designation: `Pièce usinée ${index + 1}`,
        code_piece: `PT-${String(index + 1).padStart(4, "0")}`,
        quantite: 2,
        unite: "pce",
        prix_unitaire_ht: 100,
        taux_tva: 20,
        total_ttc: 240,
      })),
      issuer: ISSUER,
    });

    const pages = drawnPages(bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("SIRET 380 569 012 00020");
      expect(page).toContain("Pénalités de retard : 12,5 % l'an");
      expect(page).toContain("Indemnité forfaitaire");
    }
  }, 90_000);
});
