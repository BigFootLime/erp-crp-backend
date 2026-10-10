import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  readGeneralTerms: vi.fn().mockResolvedValue(null),
  connect: vi.fn(),
  loadGeneration: vi.fn(),
  createDraft: vi.fn(),
  issuer: vi.fn(),
  suggestions: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: { readFile: mocks.readFile },
}));

vi.mock("../../../config/database", () => ({
  default: { connect: mocks.connect },
}));
vi.mock("../../../shared/realtime/realtime.service", () => ({
  emitAppNotificationCreated: vi.fn(),
  emitEntityChanged: vi.fn(),
}));
vi.mock("../../../shared/email/resend.service", () => ({
  sendTransactionalEmail: mocks.sendEmail,
}));
vi.mock("../../../shared/commercial-terms/commercial-terms.service", () => ({ readArchivedGeneralTerms: mocks.readGeneralTerms }));
vi.mock("../../../shared/documents/issuer-identity.repository", () => ({
  readIssuerParty: mocks.issuer,
}));
vi.mock("../../../shared/authoritative-documents/authoritative-document.service", () => ({
  getOfficialDocumentGenerationEnvelope: vi.fn(),
  getOfficialPdfDto: vi.fn(),
  readOfficialPdfBytes: mocks.readArchived,
  recordOfficialPdfPrintIntent: vi.fn(),
  officialDocumentGenerationEnvelope: vi.fn(),
}));
vi.mock("../repository/commande-ar.repository", () => ({
  buildCommandeArRecipientSuggestions: mocks.suggestions,
  repoAbortCommandeArSendClaim: mocks.abortClaim,
  repoAuthorizeCommandeArGeneration: mocks.authorizeGeneration,
  repoClaimCommandeArSend: mocks.claimSend,
  repoCreateCommandeArDraft: mocks.createDraft,
  repoFinalizeCommandeArSend: mocks.finalizeSend,
  repoFindCommandeArOfficialArchiveId: mocks.findArchive,
  repoGetCommandeArDraft: vi.fn(),
  repoLoadCommandeArGenerationData: mocks.loadGeneration,
  repoMarkCommandeArFailed: mocks.markFailed,
}));

import { buildCommandeArPdfBuffer, renderCommandeArOfficialPdf, svcGenerateCommandeAr, svcSendCommandeAr } from "./commande-ar.service";
import type { AuthoritativePdfArchiveRecord } from "../../../shared/authoritative-documents/authoritative-document.types";

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

describe("new AR customer notes and immutable archived snapshots", () => {
  const raw = "Note publique.\n\n[Commande operations]\nPriorite: CRITIQUE\nContraintes client: Certificat matière obligatoire.\nLivraison au quai 2.\n[/Commande operations]";

  it("freezes and renders the same public projection while keeping the raw fingerprint source", async () => {
    const client = { release: vi.fn() };
    const data = {
      header: { numero: "CMD-42", customer_reference: "CLIENT-42", client_company_name: "Client recette",
        date_commande: "2026-10-10", statut: "AR_PRET", total_ht: 120, total_ttc: 144, commentaire: raw },
      lines: [
        { designation: "Axe de recette", code_piece: "RF-AXE", quantite: 1, unite: "pce", prix_unitaire_ht: 40, taux_tva: 20, total_ttc: 48, delai_client: "2026-03-29" },
        { designation: "Bague de recette", code_piece: "RF-BAGUE", quantite: 1, unite: "pce", prix_unitaire_ht: 40, taux_tva: 20, total_ttc: 48, delai_client: "2026-11-01" },
        { designation: "Pièce sans date confirmée", code_piece: "RF-ATTENTE", quantite: 1, unite: "pce", prix_unitaire_ht: 40, taux_tva: 20, total_ttc: 48, delai_client: null },
      ], contacts: [], general_terms: null,
    };
    mocks.connect.mockResolvedValue(client);
    mocks.loadGeneration.mockResolvedValue(data);
    mocks.suggestions.mockReturnValue([]);
    mocks.issuer.mockResolvedValue(ISSUER);
    mocks.createDraft.mockResolvedValue({ ...GENERATED_DRAFT, preview_path: "/commandes/42/documents/fixture/file" });
    await svcGenerateCommandeAr({ commande_id: 42, user_id: 7, user_role: "secretariat" });
    const input = mocks.createDraft.mock.calls.at(-1)![0];
    expect(input.official_source_snapshot.public_comment).toBe("Note publique.\n\nExigences client :\nCertificat matière obligatoire.\nLivraison au quai 2.");
    expect(JSON.stringify(input.content_snapshot)).toContain("Priorite: CRITIQUE");
    expect(data.header.commentaire).toBe(raw);
    expect(input.official_source_snapshot.lines.map((line: { delai_client: string | null }) => line.delai_client)).toEqual(["2026-03-29", "2026-11-01", null]);
    const bytes = await input.pdf_factory({ reference: "AR-00000042-v2", version_number: 2 });
    const text = drawnPages(bytes).join("\n");
    expect(text).toContain("Note publique.");
    expect(text).toContain("Exigences client");
    expect(text).toContain("Certificat matière obligatoire.");
    expect(text).toContain("Livraison au quai 2.");
    expect(text).not.toContain("Commande operations");
    expect(text).not.toContain("Priorite:");
    expect(text).toContain("Délai de livraison : 29/03/2026");
    expect(text).toContain("Délai de livraison : 01/11/2026");
    expect(text).toContain("Délai de livraison : à confirmer");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not reinterpret public_comment in a previously frozen archive", async () => {
    const archive: AuthoritativePdfArchiveRecord = {
      id: "fixture-archive", entityType: "COMMANDE_CLIENT", entityId: "42",
      documentKind: "CUSTOMER_ORDER_ACKNOWLEDGEMENT", documentVersion: 1,
      renderVersion: "customer-ar-pdf-v1", idempotencyKey: "fixture-archive-v1",
      title: "AR-00000042-v1", originalName: "AR-00000042-v1.pdf", sourceRevision: "fixture-old-source",
      actorUserId: 7, createdAt: "2026-10-09T08:00:00.000Z", snapshotSha256: "a".repeat(64),
      exactPdfSha256: null, exactPdfSizeBytes: null, pdfSha256: null, pdfSizeBytes: null,
      gedDocumentId: null, gedVersionId: null, archivedAt: null,
      sourceSnapshot: { type: "CUSTOMER_ORDER_ACKNOWLEDGEMENT", acknowledgement_number: "AR-00000042-v1",
        order_number: "CLIENT-42", issuer: ISSUER, date_commande: "2026-10-09",
        lines: [{ designation: "Pièce archive historique", code_piece: "RF-OLD", quantite: "2", unite: "pce", prix_unitaire_ht: "40", taux_tva: "20", total_ttc: "96" }],
        total_ht: "80", total_ttc: "96", public_comment: raw },
    };
    const bytes = await renderCommandeArOfficialPdf({ archive });
    const text = drawnPages(bytes).join("\n");
    expect(text).toContain("[Commande operations]");
    expect(text).toContain("Priorite: CRITIQUE");
    expect(archive.sourceSnapshot.public_comment).toBe(raw);
    expect(text).not.toContain("Délai de livraison");
  });
});

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
      reference: "AR-00000042-v1",
      orderNumber: "ESSAI 1 GA",
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
    expect(pages.join("\n")).toContain("ESSAI 1 GA");
    for (const page of pages) {
      expect(page).toContain("SIRET 380 569 012 00020");
      expect(page).toContain("Pénalités de retard : 12,5 % l'an");
      expect(page).toContain("Indemnité forfaitaire");
    }
  }, 90_000);
});
describe("AR line delivery dates #1119", () => {
  it("renders frozen per-line dates without consulting the current order or altering the source", async () => {
    const archive: AuthoritativePdfArchiveRecord = {
      id: "fixture-line-dates", entityType: "COMMANDE_CLIENT", entityId: "42",
      documentKind: "CUSTOMER_ORDER_ACKNOWLEDGEMENT", documentVersion: 2,
      renderVersion: "customer-ar-pdf-v1", idempotencyKey: "fixture-line-dates-v2",
      title: "AR-00000042-v2", originalName: "AR-00000042-v2.pdf", sourceRevision: "frozen-source",
      actorUserId: 7, createdAt: "2026-10-10T08:00:00.000Z", snapshotSha256: "a".repeat(64),
      exactPdfSha256: null, exactPdfSizeBytes: null, pdfSha256: null, pdfSizeBytes: null,
      gedDocumentId: null, gedVersionId: null, archivedAt: null,
      sourceSnapshot: {
        type: "CUSTOMER_ORDER_ACKNOWLEDGEMENT", acknowledgement_number: "AR-00000042-v2",
        order_number: "RECETTE-DELIVERY-DATES", issuer: ISSUER, customer_name: "Client recette",
        date_commande: "2026-10-10", total_ht: "120", total_ttc: "144",
        bill_address: { name: "Client recette", city: "LYON", country: "France" },
        delivery_address: { name: "Client recette", city: "LYON", country: "France" },
        lines: [
          { designation: "Axe usiné — première échéance", code_piece: "RF-AXE", quantite: "1", unite: "pce", prix_unitaire_ht: "40", taux_tva: "20", total_ttc: "48", delai_client: "2026-03-29" },
          { designation: "Bague usinée — seconde échéance", code_piece: "RF-BAGUE", quantite: "1", unite: "pce", prix_unitaire_ht: "40", taux_tva: "20", total_ttc: "48", delai_client: "2026-11-01" },
          { designation: "Pièce — délai à confirmer", code_piece: "RF-ATTENTE", quantite: "1", unite: "pce", prix_unitaire_ht: "40", taux_tva: "20", total_ttc: "48", delai_client: null },
        ],
      },
    };
    const original = JSON.stringify(archive.sourceSnapshot);
    const loadCount = mocks.loadGeneration.mock.calls.length;
    const bytes = await renderCommandeArOfficialPdf({ archive });
    const text = drawnPages(bytes).join("\n");
    expect(text).toContain("Délai de livraison : 29/03/2026");
    expect(text).toContain("Délai de livraison : 01/11/2026");
    expect(text).toContain("Délai de livraison : à confirmer");
    expect(mocks.loadGeneration).toHaveBeenCalledTimes(loadCount);
    expect(JSON.stringify(archive.sourceSnapshot)).toBe(original);
    if (process.env.OBS065_RENDER_PROOF_DIR) {
      mkdirSync(process.env.OBS065_RENDER_PROOF_DIR, { recursive: true });
      writeFileSync(path.join(process.env.OBS065_RENDER_PROOF_DIR, "ar-line-dates.pdf"), bytes);
    }
  });
});
