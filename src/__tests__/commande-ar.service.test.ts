import { describe, expect, it } from "vitest";

import {
  buildCommandeArPdfBuffer,
  buildCommandeArEmailContent,
  renderCommandeArEmailHtml,
  sha256Canonical,
} from "../module/commande-client/services/commande-ar.service";
import { sendCommandeArSchema } from "../module/commande-client/validators/commande-ar.validators";

describe("commande AR email content", () => {
  it("uses the required French subject and keeps the custom message before the signature in text and HTML", () => {
    const email = buildCommandeArEmailContent({
      numero: "CMD-2026-42",
      customer_reference: "PO-CLIENT-9",
      reference: "AR-00000001-v2",
      contact: {
        contact_id: "11111111-1111-1111-1111-111111111111",
        civility: "Mme",
        first_name: "Élodie",
        last_name: "Dœ",
        email: "elodie@example.test",
      },
      custom_message: "Merci de vérifier <ce délai> & de nous répondre.",
    });

    expect(email.subject).toBe("Accusé de réception de votre commande CMD-2026-42 — AR-00000001-v2");
    expect(email.text).toContain("Bonjour Mme Élodie Dœ,");
    expect(email.text).toContain("commande PO-CLIENT-9, enregistrée dans CERP sous le numéro CMD-2026-42.");
    expect(email.text.indexOf("Merci de vérifier")).toBeLessThan(email.text.indexOf("Cordialement,"));
    expect(email.html).toContain("Merci de vérifier &lt;ce délai&gt; &amp; de nous répondre.");
    expect(email.html.indexOf("Merci de vérifier")).toBeLessThan(email.html.indexOf("Cordialement,"));
  });

  it("uses Madame, Monsieur when the send does not select exactly one contact", () => {
    const email = buildCommandeArEmailContent({
      numero: "CMD-1",
      customer_reference: null,
      reference: "AR-00000001-v1",
      contact: null,
    });
    expect(email.text).toContain("Bonjour Madame, Monsieur,");
    expect(email.text).toContain("commande CMD-1, enregistrée dans CERP sous le numéro CMD-1.");
  });

  it("escapes arbitrary HTML while preserving French accents", () => {
    const html = renderCommandeArEmailHtml("Bonjour\n\nÉchéance : <urgent> & confirmé");
    expect(html).toContain("Échéance : &lt;urgent&gt; &amp; confirmé");
    expect(html).not.toContain("<urgent>");
  });
});

describe("commande AR PDF", () => {
  it("renders a readable versioned A4 PDF buffer", async () => {
    const pdf = await buildCommandeArPdfBuffer({
      reference: "AR-00000001-v2",
      issuer: { company_name: "CROIX ROUSSE PRÉCISION", legal_form: "SARL", siret: "38056901200020" },
      draftNumber: "CMD-2026-42",
      companyName: "Client Démonstration",
      dateCommande: "2026-08-26",
      statut: "AR_PRET",
      totalHt: 1250,
      totalTtc: 1500,
      commentaire: "Contrôle final avant expédition.",
      clientEmail: "client@example.test",
      clientPhone: "+33 4 00 00 00 00",
      billAddress: { street: "1 rue des Ateliers", postal_code: "69004", city: "Lyon", country: "France" },
      deliveryAddress: { street: "2 quai de Saône", postal_code: "69009", city: "Lyon", country: "France" },
      lines: [
        {
          id: 1,
          code_piece: "PT-42",
          designation: "Bride usinée",
          quantite: 5,
          unite: "pcs",
          prix_unitaire_ht: 250,
          taux_tva: 20,
          total_ttc: 1500,
          delai_client: "2026-09-15",
          delai_interne: "2026-09-12",
        },
      ],
    });

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });
});

describe("commande AR validation and fingerprints", () => {
  it("rejects duplicate recipients and duplicate selected contacts", () => {
    const result = sendCommandeArSchema.safeParse({
      params: { id: "42" },
      body: {
        ar_id: "11111111-1111-1111-1111-111111111111",
        recipient_emails: ["Client@example.test", "client@example.test"],
        recipient_contact_ids: ["22222222-2222-2222-2222-222222222222", "22222222-2222-2222-2222-222222222222"],
      },
    });
    expect(result.success).toBe(false);
  });

  it("creates a stable content fingerprint regardless of object-key insertion order", () => {
    expect(sha256Canonical({ b: [2, { z: true, a: "é" }], a: 1 })).toBe(
      sha256Canonical({ a: 1, b: [2, { a: "é", z: true }] })
    );
  });
});
