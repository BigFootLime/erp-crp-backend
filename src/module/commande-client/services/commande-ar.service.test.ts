import { inflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../config/database", () => ({
  default: { connect: vi.fn() },
}));
vi.mock("../../../shared/realtime/realtime.service", () => ({
  emitAppNotificationCreated: vi.fn(),
  emitEntityChanged: vi.fn(),
}));
vi.mock("../../../shared/email/resend.service", () => ({
  sendTransactionalEmail: vi.fn(),
}));
vi.mock("../../../shared/documents/issuer-identity.repository", () => ({
  readIssuerParty: vi.fn(),
}));
vi.mock("../repository/commande-ar.repository", () => ({
  buildCommandeArRecipientSuggestions: vi.fn(),
  repoCreateCommandeArDraft: vi.fn(),
  repoFinalizeCommandeArSend: vi.fn(),
  repoGetCommandeArDraft: vi.fn(),
  repoLoadCommandeArGenerationData: vi.fn(),
  repoMarkCommandeArFailed: vi.fn(),
}));

import { buildCommandeArPdfBuffer } from "./commande-ar.service";

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
