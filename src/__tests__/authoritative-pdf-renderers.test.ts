import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { renderSupplierPurchaseOrderOfficialPdf } from "../module/commande-fournisseur/services/commande-fournisseur-official-pdf";
import { renderDevisOfficialPdf } from "../module/devis/services/devis-official-pdf";
import { renderCommandeArOfficialPdf } from "../module/commande-client/services/commande-ar.service";
import { renderClientProfilePdf } from "../module/client/services/client-profile-pdf";
import { renderCerpDocument } from "../shared/pdf/cerp-document";
import { CERP_LOGO_PNG } from "../shared/pdf/cerp-logo";
import { parseInternalCreationSnapshot, renderInternalCreationSnapshotPdf } from "../shared/authoritative-documents/internal-creation-snapshot-pdf";
import { buildInternalCreationSnapshot } from "../shared/authoritative-documents/internal-creation-snapshot";

const archive = (sourceSnapshot: Record<string, unknown>) => ({
  id: "11111111-1111-4111-8111-111111111111", entityType: "fixture", entityId: "42", documentKind: "FIXTURE",
  documentVersion: 7, renderVersion: "qa-render-v1", idempotencyKey: "fixture:42:creation:v1", title: "Fixture", originalName: "fixture.pdf",
  sourceRevision: "2026-08-23 10:00:00+00", createdAt: "2026-08-23T10:00:00.000Z",
  sourceSnapshot, snapshotSha256: "a".repeat(64), pdfSha256: null, pdfSizeBytes: null, gedDocumentId: null,
  gedVersionId: null, archivedAt: null, actorUserId: 1,
});

const issuer = { company_name: "CROIX ROUSSE PRECISION", legal_form: "SARL", siret: "38056901200020" };

function pageTexts(bytes: Buffer): string[] {
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
    let stream: string;
    try { stream = inflateSync(bytes.subarray(from, end)).toString("latin1"); }
    catch { continue; }
    pages.push([...stream.matchAll(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]+>/g)]
      .map((match) => {
        const value = match[0];
        if (value.startsWith("<")) return Buffer.from(value.slice(1, -1).replace(/\s+/g, ""), "hex").toString("latin1");
        return value.slice(1, -1).replace(/\\([()\\])/g, "$1");
      })
      .join(" "));
  }
  return pages;
}

// PDFKit can split one visual word across several text-showing operations.  The
// layout assertion therefore compares a compact form rather than assuming the
// internal PDF text operators retain visual word boundaries.
function compactPdfText(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

describe("Wave-1 official PDF renderers", () => {
  it("embeds a supplied entity image in the shared PDF identity slot", async () => {
    const bytes = await renderCerpDocument({
      documentType: "Fiche client", name: "Atelier Logo", code: "CLI-LOGO", status: "Client",
      monogramName: "Atelier Logo", entityImage: CERP_LOGO_PNG, generatedAt: "24/08/2026",
      title: "Fiche client logo", subject: "Test du logo GED", creationDate: new Date("2026-08-24T10:00:00Z"),
    }, (ctx) => ctx.legalStrip([{ label: "Client", value: "Atelier Logo" }]));

    const imageObjects = bytes.toString("latin1").match(/\/Subtype \/Image\b/g) ?? [];
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(imageObjects.length).toBeGreaterThanOrEqual(2);
  });

  it("freezes the exact GED image revision in the generic module snapshot", () => {
    const versionId = "22222222-2222-4222-8222-222222222222";
    const source = buildInternalCreationSnapshot({
      entityLabel: "Atelier Logo",
      reference: "CLI-LOGO",
      entityImageVersionId: versionId,
      sections: [{ title: "Identité", rows: [{ label: "Nom", value: "Atelier Logo" }] }],
    });

    expect(source.entity_image).toEqual({ ged_version_id: versionId });
    expect(parseInternalCreationSnapshot(archive(source))).toMatchObject({
      entity_image: { ged_version_id: versionId },
    });
  });

  it("renders a long internal creation snapshot as visibly non-opposable", async () => {
    const bytes = await renderInternalCreationSnapshotPdf({ archive: archive(buildInternalCreationSnapshot({
      entityLabel: "Fiche client", reference: "CLI-0042", issuer,
      summary: [{ label: "Client", value: "Client Test" }],
      sections: [{ title: "Données", rows: Array.from({ length: 50 }, (_, index) => ({ label: `Champ ${index}`, value: `Valeur ${index}` })) }],
    })) });
    const text = compactPdfText(pageTexts(bytes).join(" "));
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(text).toContain("INTERNE/BROUILLON");
    expect(text).toContain("NONOPPOSABLE");
    expect(text).toContain("VALEUR49");
  });

  it("renders the consolidated client profile as a distinct GED document without the internal watermark", async () => {
    const bytes = await renderClientProfilePdf({ archive: {
      ...archive(buildInternalCreationSnapshot({
        entityLabel: "Atelier ACME", reference: "CLI-724", issuer,
        summary: [
          { label: "Statut", value: "client" }, { label: "Bloqué", value: "Non" },
          { label: "Client depuis", value: "2026-08-23" }, { label: "Factureur", value: "CRP" },
        ],
        sections: [
          { title: "Coordonnées", rows: [
            { label: "Email", value: "contact@atelier-acme.test" }, { label: "Téléphone", value: "+33 4 00 00 00 00" },
            { label: "Site web", value: "https://atelier-acme.test" }, { label: "SIRET", value: "12345678901234" },
            { label: "TVA intracommunautaire", value: "FR00123456789" }, { label: "Code NAF", value: "2562B" },
          ] },
          { title: "Observations", notes: "Fiche consolidée et versionnée." },
        ],
      })),
      entityType: "client", entityId: "724", documentKind: "CLIENT_PROFILE", documentVersion: 2,
    } });
    const text = compactPdfText(pageTexts(bytes).join(" "));
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(text).toContain("FICHECLIENT");
    expect(text).toContain("ATELIERACME");
    expect(text).toContain("CONTACT@ATELIER-ACME.TEST");
    expect(text).not.toContain("INTERNE/BROUILLON");
  });

  it("sanitizes creation-table columns and persists only declared bounded cells", () => {
    const snapshot = buildInternalCreationSnapshot({
      entityLabel: "Article", reference: "ART-42",
      sections: [{
        title: "Données",
        table: {
          columns: [
            { key: "reference", label: "Référence" },
            { key: "reference", label: "Doublon" },
            { key: "../secret", label: "Invalide" },
          ],
          rows: [{ reference: "ART-42", unexpected: "must-not-enter-the-archive" }],
        },
      }],
    });
    const table = snapshot.sections[0]?.table;
    expect(table?.columns).toEqual([{ key: "reference", label: "Référence" }]);
    expect(table?.rows).toEqual([{ reference: "ART-42" }]);
  });

  it.each([
    { reference: "ART-42", unexpected: "extra" },
    { reference: 42 },
    ["ART-42"],
  ])("rejects a malformed immutable creation-table row %#", (row) => {
    const source = buildInternalCreationSnapshot({
      entityLabel: "Article", reference: "ART-42",
      sections: [{ title: "Données", table: { columns: [{ key: "reference", label: "Référence" }], rows: [{ reference: "ART-42" }] } }],
    });
    const malformed = { ...source, sections: [{ ...source.sections[0], table: { ...source.sections[0]!.table!, rows: [row] } }] };
    expect(() => parseInternalCreationSnapshot(archive(malformed))).toThrow("INTERNAL_CREATION_SNAPSHOT_INVALID");
  });

  it("renders a supplier PO only from its frozen external-safe snapshot", async () => {
    const bytes = await renderSupplierPurchaseOrderOfficialPdf({ archive: archive({
      type: "SUPPLIER_PURCHASE_ORDER", code: "BCF-2026-0042", status: "BROUILLON", issued_at: "2026-08-23T10:00:00Z",
      supplier: { code: "SUP-42", name: "Fournisseur Test", address: { street: "Rue des Forges", house_number: "12", postal_code: "69007", city: "Lyon", country: "France" } }, currency: "EUR", need_date: null, incoterm: null,
      payment_terms: null, transport_mode: null, public_comment: "Livrer avec certificat.", delivery_address: null,
      lines: [{ position: 1, reference: "MAT-01", designation: "Matière", unit: "kg", quantity: "12.500", unit_price_ht: "10.00", discount_pct: "0", vat_pct: "20", net_ht: "125.00", need_date: null }],
      totals: { total_ht: "125.00", total_discount: "0.00", total_vat: "25.00", freight_ht: "17.00", total_ttc: "167.00" }, issuer,
    }) });
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const text = compactPdfText(pageTexts(bytes).join(" "));
    expect(text).toContain("INTERNE/BROUILLON");
    expect(text).toContain("FRAISDEPORTHT");
    expect(text).toContain("RUEDESFORGES");
    expect(text).toContain("VERSION7");
    expect(text).not.toContain("QARENDERV1");
    expect(text).not.toContain("ORIGINALGED");
  });

  it("renders a quote from precise decimal-string totals", async () => {
    const bytes = await renderDevisOfficialPdf({ archive: archive({
      type: "CUSTOMER_QUOTE", number: "DEV-2026-0042", status: "BROUILLON", issued_at: "2026-08-23T10:00:00Z", valid_until: "2026-09-22", version: "1",
      customer: { code: "CLI-042", name: "Client Test", address: { name: "Client Test", street: "Avenue des Alpes", house_number: "4", postal_code: "74000", city: "Annecy", country: "France" } }, currency: "EUR", public_comment: null,
      lines: [{ position: 1, reference: "PT-42", designation: "Pièce usinée", quantity: "2.000", unit: "pce", unit_price_ht: "1200.50", discount_pct: "2.50", vat_pct: "20.00", total_ht: "2340.975", total_ttc: "2809.170" }],
      totals: { total_ht: "2340.975", total_ttc: "2809.170", global_discount_pct: "0.00" }, issuer,
    }) });
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const text = compactPdfText(pageTexts(bytes).join(" "));
    expect(text).toContain("INTERNE/BROUILLON");
    expect(text).toContain("CLI-042");
    expect(text).toContain("AVENUEDESALPES");
    expect(text).toContain("VERSION7");
    // PDF text streams encode the Euro glyph as a legacy single-byte code;
    // assert the canonical rendered amount rather than that extractor detail.
    expect(text).toContain("2340,98");
    expect(text).not.toContain("2340,975");
    expect(text).not.toContain("QARENDERV1");
  });

  it("repeats the table header instead of letting PDFKit split a discounted row", async () => {
    const lines = Array.from({ length: 42 }, (_, index) => ({
      position: index + 1,
      reference: `PT-${String(index + 1).padStart(3, "0")}`,
      designation: `Pièce usinée aéronautique ${index + 1} — contrôle dimensionnel et traçabilité lot exigée`,
      quantity: String(index + 1),
      unit: "pce",
      unit_price_ht: "1234.56",
      discount_pct: index % 3 === 0 ? "2.50" : null,
      vat_pct: "20.00",
      total_ht: String((index + 1) * 1234.56),
      total_ttc: String((index + 1) * 1481.472),
    }));
    const bytes = await renderDevisOfficialPdf({ archive: archive({
      type: "CUSTOMER_QUOTE", number: "DEV-LONG-42", status: "BROUILLON", issued_at: "2026-08-23T10:00:00Z",
      valid_until: "2026-09-22", version: "1", customer: { code: "CLI-042", name: "Client Test" },
      currency: "EUR", public_comment: null, lines,
      totals: { total_ht: "111111.11", total_ttc: "133333.33", global_discount_pct: "2.50" }, issuer,
    }) });
    const text = compactPdfText(pageTexts(bytes).join(" "));
    const pdfPageCount = bytes.toString("latin1").match(/\/Type \/Page\b/g)?.length ?? 0;
    const repeatedHeaders = text.match(/RÉFÉRENCE/g)?.length ?? 0;

    expect(pdfPageCount).toBeGreaterThan(1);
    expect(repeatedHeaders).toBe(pdfPageCount);
    for (let index = 1; index <= 42; index += 1) {
      expect(text).toContain(`PT-${String(index).padStart(3, "0")}`);
    }
  });

  it("keeps the source issue date visible while stamping a reissue with its immutable archive time", async () => {
    const bytes = await renderDevisOfficialPdf({ archive: {
      ...archive({
        type: "CUSTOMER_QUOTE", number: "DEV-2025-0007", status: "ENVOYE", issued_at: "2025-01-02T09:00:00Z", valid_until: null, version: "1",
        customer: { code: "CLI-007", name: "Client Test" }, currency: "EUR", public_comment: null,
        lines: [{ position: 1, reference: null, designation: "Prestation", quantity: "1", unit: "u", unit_price_ht: "100.00", discount_pct: null, vat_pct: "20", total_ht: "100.00", total_ttc: "120.00" }],
        totals: { total_ht: "100.00", total_ttc: "120.00", global_discount_pct: null }, issuer,
      }),
      documentVersion: 2,
      createdAt: "2026-08-23T10:00:00.000Z",
    } });
    const compact = compactPdfText(pageTexts(bytes).join(" "));
    expect(compact).toContain("VERSION2");
    expect(compact).toContain("ÉMISLE02/01/2025");
    expect(compact).toContain("GÉNÉRÉLE23/08/2026");
    expect(bytes.toString("latin1")).toContain("/CreationDate");
  });

  it("marks a draft customer acknowledgement as internal rather than an issued original", async () => {
    const bytes = await renderCommandeArOfficialPdf({ archive: archive({
      type: "CUSTOMER_ORDER_ACKNOWLEDGEMENT", acknowledgement_id: "11111111-1111-4111-8111-111111111112",
      acknowledgement_number: "AR-CC-2026-0042", order_number: "CC-2026-0042", generated_at: "2026-08-23T10:00:00Z",
      status: "BROUILLON", customer_name: "Client Test", date_commande: "2026-08-20", total_ht: "125.00", total_ttc: "150.00",
      public_comment: null, bill_address: {}, delivery_address: {},
      lines: [{ designation: "Pièce usinée", code_piece: "PT-42", quantite: "1", unite: "pce", prix_unitaire_ht: "125.00", taux_tva: "20", total_ttc: "150.00" }],
      issuer,
    }) });
    const text = compactPdfText(pageTexts(bytes).join(" "));
    expect(text).toContain("INTERNE/BROUILLON");
    expect(text).toContain("VERSION7");
    expect(text).toContain("AR-CC-2026-0042");
    expect(text).toContain("RÉFÉRENCECOMMANDECLIENTCC-2026-0042");
    expect(text).not.toContain("ORIGINALGED");
    expect(text).not.toContain("QARENDERV1");
  });

  it("paginates a long note in bounded blocks above the legal footer", async () => {
    const note = Array.from({ length: 450 }, (_, index) => `Instruction-${index} de production et de conformité.`).join(" ");
    const bytes = await renderCerpDocument({
      documentType: "Test", name: "Note longue", code: "TEST-1", status: "BROUILLON", monogramName: "Test",
      generatedAt: "23/08/2026", title: "Test notes", subject: "Test", creationDate: new Date("2026-08-23T10:00:00Z"),
      legalIdentity: "CERP", legalMentions: ["Mention légale de test"],
    }, (ctx) => ctx.notesSection("Notes", note));
    const pages = pageTexts(bytes);
    expect(pages.length).toBeGreaterThan(1);
    expect(compactPdfText(pages.join(" "))).toContain("INSTRUCTION-449");
  });
});
