/**
 * Rendu reel de la facture et de l'avoir.
 *
 * Ces documents sont **fiscaux** : leur contenu est encadre par la loi et l'exemplaire emis
 * est immuable. Une regression n'est pas rattrapable sur les factures deja transmises.
 *
 * Le texte est relu dans les flux de contenu du PDF, decompresses et decodes en WinAnsi : on
 * verifie ce que le document **affiche**, pas ce que le code croit avoir ecrit.
 *
 * `CERP_PDF_PREVIEW=1` ecrit les PDF dans `outputs/pdf-preview` pour inspection visuelle.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";
import { getGeneratedRootPath } from "../../../utils/cerpStorage";

import { issuerIdentityLine, issuerLegalMentions } from "../../../shared/pdf/legal-mentions";

import {
  money,
  percent,
  renderFinanceDocument,
  taxBreakdown,
  partyLines,
  type FinanceDocumentInput,
  type FinanceDocumentLine,
} from "./finance-document-render";

const PREVIEW_ENABLED = process.env.CERP_PDF_PREVIEW === "1";
const PREVIEW_DIR = process.env.CERP_PDF_PREVIEW_DIR ?? getGeneratedRootPath("pdf-preview");

function keep(name: string, bytes: Buffer): void {
  if (!PREVIEW_ENABLED) return;
  mkdirSync(PREVIEW_DIR, { recursive: true });
  writeFileSync(resolve(PREVIEW_DIR, `${name}.pdf`), bytes);
}

/** WinAnsi, pas latin1 : les deux divergent de 0x80 a 0x9F (tiret cadratin, apostrophe). */
const WINANSI = new TextDecoder("windows-1252");

function drawnPages(bytes: Buffer): string[] {
  const decodeOperands = (operands: string): string =>
    [...operands.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)]
      .map((m) =>
        m[1] !== undefined
          ? WINANSI.decode(Buffer.from(m[1].replace(/\s+/g, ""), "hex"))
          : m[2].replace(/\\([()\\])/g, "$1")
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
        ...[...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) => decodeOperands(m[1])),
        ...[...content.matchAll(/(<[0-9a-fA-F\s]*>|\((?:\\.|[^\\)])*\))\s*Tj/g)].map((m) => decodeOperands(m[1])),
      ].join("\n")
    );
  }

  return pages;
}

function drawnText(bytes: Buffer): string {
  return drawnPages(bytes).join("\n");
}

/** Identifiant technique du client : il ne doit apparaitre sur aucun document financier. */
const CLIENT_UUID = "8f1c2b4e-7d3a-4f56-9c21-0ab5d6e7f890";

const ISSUER = {
  company_name: "CROIX ROUSSE PRECISION",
  address_line_1: "12 rue de la Precision",
  postal_code: "69004",
  city: "LYON",
  country: "France",
  siret: "123 456 789 00012",
  vat_number: "FR12345678900",
};

const CLIENT = {
  client_id: CLIENT_UUID,
  company_name: "ABB FRANCE",
  siret: "987 654 321 00021",
  vat_number: "FR98765432100",
  billing_address: {
    house_number: "12",
    street: "ZA LA BOISSE",
    postal_code: "01125",
    city: "MONTLUEL CEDEX",
    country: "France",
  },
};

function ligne(overrides: Partial<FinanceDocumentLine> = {}): FinanceDocumentLine {
  return {
    designation: "Corps de vanne inox 316L — usinage complet, plan 4501-A indice C",
    codePiece: "PT-4501-A",
    quantity: "40",
    unit: "pce",
    unitPriceExTax: "182.40",
    discountPercent: "0.00",
    taxRatePercent: "20.00",
    totalExTax: "7296.00",
    taxAmount: "1459.20",
    totalInclTax: "8755.20",
    ...overrides,
  };
}

const FACTURE: FinanceDocumentInput = {
  kind: "FACTURE",
  number: "FA-2026-0142",
  draft: false,
  issueDate: "2026-07-22",
  currency: "EUR",
  issuer: ISSUER,
  client: CLIENT,
  lines: [
    ligne(),
    ligne({
      designation: "Bague de guidage bronze — tournage et rectification",
      codePiece: "PT-4502-B",
      quantity: "120",
      unitPriceExTax: "27.80",
      discountPercent: "5.00",
      totalExTax: "3169.20",
      taxAmount: "633.84",
      totalInclTax: "3803.04",
    }),
  ],
  totals: {
    subtotalExTax: "10465.20",
    globalDiscountPercent: "0.00",
    globalDiscountAmount: "0.00",
    totalExTax: "10465.20",
    totalTax: "2093.04",
    totalInclTax: "12558.24",
  },
  dueDates: [
    { dueDate: "2026-08-21", label: "30 jours net", amount: "6279.12" },
    { dueDate: "2026-09-20", label: "60 jours net", amount: "6279.12" },
  ],
  customerText: "Règlement par virement sur le compte habituel, en rappelant le numéro de facture.",
  snapshotUuid: "3f6a1c88-2b4d-4a11-9d0e-5c7b2a9e4d31",
  draftReference: "BRO-2026-0142",
};

const AVOIR: FinanceDocumentInput = {
  ...FACTURE,
  kind: "AVOIR",
  number: "AV-2026-0007",
  correctedInvoice: "FA-2026-0142",
  reasonCode: "NON_CONFORME",
  reason: "Pièces refusées au contrôle réception : cote hors tolérance sur le lot LOT-2026-0002.",
  dueDates: [],
  customerText: null,
  lines: [ligne({ quantity: "4", totalExTax: "729.60", taxAmount: "145.92", totalInclTax: "875.52" })],
  totals: {
    subtotalExTax: "729.60",
    globalDiscountPercent: "0.00",
    globalDiscountAmount: "0.00",
    totalExTax: "729.60",
    totalTax: "145.92",
    totalInclTax: "875.52",
  },
};

describe("ventilation de la TVA", () => {
  it("regroupe par taux et somme en centimes", () => {
    // Mention obligatoire : base HT et montant de taxe pour chaque taux applique.
    const taxes = taxBreakdown([
      ligne({ taxRatePercent: "20.00", totalExTax: "100.00", taxAmount: "20.00" }),
      ligne({ taxRatePercent: "20.00", totalExTax: "50.05", taxAmount: "10.01" }),
      ligne({ taxRatePercent: "5.50", totalExTax: "10.10", taxAmount: "0.56" }),
    ]);

    expect(taxes).toEqual([
      { ratePercent: "5.50", baseExTax: "10.10", taxAmount: "0.56" },
      { ratePercent: "20.00", baseExTax: "150.05", taxAmount: "30.01" },
    ]);
  });

  it("ne derive pas en virgule flottante sur des montants a un centime", () => {
    // 0.1 + 0.2 en flottant donne 0.30000000000000004 : la somme se fait en centiers entiers.
    const taxes = taxBreakdown([
      ligne({ taxRatePercent: "20.00", totalExTax: "0.10", taxAmount: "0.02" }),
      ligne({ taxRatePercent: "20.00", totalExTax: "0.20", taxAmount: "0.04" }),
    ]);
    expect(taxes[0].baseExTax).toBe("0.30");
  });

  it("ne recalcule jamais la taxe a partir du taux", () => {
    // Le referentiel fait foi : si la taxe fournie est 0, le document affiche 0 — il ne
    // reapplique pas 20 % de son propre chef.
    const taxes = taxBreakdown([ligne({ taxRatePercent: "20.00", totalExTax: "100.00", taxAmount: "0.00" })]);
    expect(taxes[0].taxAmount).toBe("0.00");
  });
});

describe("format des montants", () => {
  it("rend un montant a la francaise sans toucher aux chiffres", () => {
    expect(money("10465.20", "EUR")).toBe("10 465,20 €");
    expect(money("182.40", "EUR")).toBe("182,40 €");
    expect(money("0.00", "EUR")).toBe("0,00 €");
    expect(money("1234567.89", "EUR")).toBe("1 234 567,89 €");
  });

  it("conserve le signe d'un montant negatif", () => {
    // Un montant negatif devenu positif ferait mentir la piece.
    expect(money("-313.96", "EUR")).toBe("-313,96 €");
  });

  it("rend un pourcentage a la francaise", () => {
    expect(percent("20.00")).toBe("20,00 %");
    expect(percent("5.5")).toBe("5,5 %");
  });

  it("garde le code ISO pour une autre devise", () => {
    expect(money("100.00", "USD")).toBe("100,00 USD");
  });

  it("ne perd pas une valeur qui n'est pas un nombre", () => {
    expect(money("n/a", "EUR")).toBe("n/a €");
  });
});

describe("identite des parties", () => {
  it("imprime les mentions fiscales quand elles existent", () => {
    const lines = partyLines(ISSUER);
    expect(lines).toContain("SIRET 123 456 789 00012");
    expect(lines).toContain("TVA FR12345678900");
    expect(lines).toContain("CROIX ROUSSE PRECISION");
  });

  it("n'invente aucune mention absente", () => {
    // Une identite reduite ne doit pas produire de « SIRET — » ni de ligne vide.
    const lines = partyLines({ company_name: "ATELIER DU VAL DE SAONE" });
    expect(lines).toEqual(["ATELIER DU VAL DE SAONE"]);
  });

  it("n'imprime jamais l'identifiant technique du client", () => {
    expect(partyLines(CLIENT).join("\n")).not.toContain(CLIENT_UUID);
  });
});

describe("facture — rendu reel", () => {
  it("scenario 1 (facture emise, 2 taux) : une page, mentions portees", async () => {
    const bytes = await renderFinanceDocument(FACTURE);
    keep("60-facture-emise", bytes);

    expect(bytes.byteLength).toBeGreaterThan(1000);
    const pages = drawnPages(bytes);
    expect(pages).toHaveLength(1);

    const text = pages[0];
    expect(text).toContain("FA-2026-0142");
    expect(text).toContain("Page 1 / 1");
    // Identite des deux parties, mentions fiscales comprises.
    expect(text).toContain("CROIX ROUSSE PRECISION");
    expect(text).toContain("SIRET 123 456 789 00012");
    expect(text).toContain("ABB FRANCE");
    expect(text).toContain("TVA FR98765432100");
    // Ventilation de la TVA et totaux.
    expect(text).toContain("RÉCAPITULATIF");
      expect(text).toContain("MONTANT TVA");
    expect(text).toContain("2 093,04 €");
    // Echeances.
    expect(text).toContain("21/08/2026");
    expect(text).toContain("30 jours net");
  }, 60_000);

  it("n'imprime jamais l'identifiant technique du client", async () => {
    // Regression : l'ancienne version ecrivait `ID: <uuid>` sous la raison sociale.
    const bytes = await renderFinanceDocument(FACTURE);
    expect(drawnText(bytes)).not.toContain(CLIENT_UUID);
  }, 60_000);

  it("scenario 2 (brouillon) : se denonce comme non transmissible", async () => {
    // Un brouillon imprime n'a aucune valeur fiscale : il doit le dire lui-meme.
    const bytes = await renderFinanceDocument({ ...FACTURE, draft: true, snapshotUuid: null });
    keep("61-facture-brouillon", bytes);

    const text = drawnText(bytes);
    expect(text).toContain("Brouillon");
    expect(text).toContain("NE PAS TRANSMETTRE");
  }, 60_000);

  it("scenario 3 (remise globale) : sous-total et remise apparaissent", async () => {
    const bytes = await renderFinanceDocument({
      ...FACTURE,
      totals: { ...FACTURE.totals, globalDiscountPercent: "3.00", globalDiscountAmount: "313.96" },
    });
    keep("62-facture-remise", bytes);

    const text = drawnText(bytes);
    expect(text).toContain("Sous-total HT");
    expect(text).toContain("Remise globale (3,00 %)");
    // La remise est bien retranchee a l'affichage, jamais presentee en positif.
    expect(text).toContain("- 313,96 €");
  }, 60_000);

  it("scenario 4 (40 lignes) : pagine et reemet l'en-tete de table", async () => {
    const bytes = await renderFinanceDocument({
      ...FACTURE,
      lines: Array.from({ length: 40 }, (_, index) =>
        ligne({ designation: `Composant usiné référence ${index + 1} — plan 46${index}-A indice B` })
      ),
    });
    keep("63-facture-volume", bytes);

    const pages = drawnPages(bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      if (/PT-4501-A/.test(page)) expect(page).toContain("DÉSIGNATION");
    }
    pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} / ${pages.length}`);
      if (index > 0) expect(page).toContain("FA-2026-0142");
    });
  }, 90_000);

  it("scenario 5 (identite emetteur incomplete) : le document reste lisible", async () => {
    // Le referentiel `factureur` est historique : rien ne garantit qu'il porte SIRET et TVA.
    // Le document ne doit alors ni planter, ni afficher de mention vide.
    const bytes = await renderFinanceDocument({
      ...FACTURE,
      issuer: { biller_name: "CROIX ROUSSE PRECISION" },
      client: { company_name: "ATELIER DU VAL DE SAONE" },
    });
    keep("64-facture-emetteur-minimal", bytes);

    const text = drawnText(bytes);
    expect(text).toContain("CROIX ROUSSE PRECISION");
    expect(text).toContain("ATELIER DU VAL DE SAONE");
    // Aucune mention fiscale inventee, aucune etiquette laissee vide.
    expect(text).not.toContain("SIRET ");
    expect(text).not.toContain("TVA FR");
    expect(drawnPages(bytes)).toHaveLength(1);
  }, 60_000);

  it("les accents et le tiret cadratin survivent a WinAnsi", async () => {
    const bytes = await renderFinanceDocument(FACTURE);
    const text = drawnText(bytes);
    expect(text).toContain("DÉSIGNATION");
    expect(text).toContain("Émetteur".toUpperCase());
    expect(text).toContain("316L — usinage complet");
  }, 60_000);
});

describe("avoir — rendu reel", () => {
  it("scenario 6 (avoir emis) : facture corrigee et motif portes", async () => {
    const bytes = await renderFinanceDocument(AVOIR);
    keep("65-avoir-emis", bytes);

    const pages = drawnPages(bytes);
    expect(pages).toHaveLength(1);

    const text = pages[0];
    expect(text).toContain("AV-2026-0007");
    expect(text).toContain("FA-2026-0142");
    expect(text).toContain("NON_CONFORME");
    expect(text).toContain("Total TTC à créditer");
    expect(text).toContain("Page 1 / 1");
  }, 60_000);

  it("n'affiche pas d'echeances : un avoir ne se regle pas", async () => {
    const bytes = await renderFinanceDocument(AVOIR);
    expect(drawnText(bytes)).not.toContain("ÉCHÉANCES DE RÈGLEMENT");
  }, 60_000);

  it("n'imprime jamais l'identifiant technique du client", async () => {
    const bytes = await renderFinanceDocument(AVOIR);
    expect(drawnText(bytes)).not.toContain(CLIENT_UUID);
  }, 60_000);
});

describe("facture et avoir partagent la meme grammaire", () => {
  it("portent tous deux le pied de page pagine et le rappel d'identite", async () => {
    const [facture, avoir] = await Promise.all([
      renderFinanceDocument(FACTURE),
      renderFinanceDocument(AVOIR),
    ]);
    for (const bytes of [facture, avoir]) {
      const text = drawnText(bytes);
      expect(text).toContain("CROIX ROUSSE PRECISION");
      expect(text).toContain("Page 1 / 1");
      expect(text).toContain("RÉCAPITULATIF");
      expect(text).toContain("MONTANT TVA");
    }
  }, 90_000);
});

/**
 * Mentions legales obligatoires de l'emetteur.
 *
 * Le referentiel ne les portait pas : `factureur` n'a aucune colonne legale et etait vide
 * sur les deux bases. Elles viennent desormais de `finance_legal_mentions`, versionnee, et
 * sont figees dans l'instantane a la date d'emission.
 *
 * Elles sont verifiees **dans le texte reellement dessine**, pas sur l'objet d'entree : une
 * mention presente dans l'instantane mais absente du PDF est juridiquement absente.
 */

/** Instantane complet, tel que le renvoie `fn_finance_issuer_snapshot`. */
const ISSUER_MENTIONS = {
  company_name: "CROIX ROUSSE PRECISION",
  address_line_1: "530 Rue de la Dombes",
  postal_code: "01700",
  city: "MIRIBEL LES ECHETS",
  country: "France",
  phone: "04 72 00 26 25",
  legal_form: "SARL",
  share_capital: "21000.00",
  share_capital_currency: "EUR",
  rcs_city: "Bourg-en-Bresse",
  rcs_number: "380 569 012",
  siren: "380 569 012",
  siret: "380 569 012 00020",
  vat_number: "FR73 380 569 012",
  late_penalty_rate: "12.500",
  late_penalty_basis: "ANNUEL",
  recovery_indemnity: "40.00",
  early_discount_rate: "1.500",
  early_discount_basis: "MENSUEL",
  vat_on_receipts: true,
  retention_of_title:
    "Nous nous réservons la propriété des marchandises jusqu'au paiement intégral du prix par l'acheteur.",
  iban: "FR76 3000 3024 9100 0200 0775 958",
  bic: "SOGEFRPP",
  bank_name: "SG LYON CROIX-ROUSSE",
  legal_mentions_version: 1,
  legal_mentions_effective_from: "2026-01-01",
};

const FACTURE_MENTIONS: FinanceDocumentInput = { ...FACTURE, issuer: ISSUER_MENTIONS };

describe("identite legale de l'emetteur", () => {
  it("compose la ligne portee par le pied de page", () => {
    // Art. R123-237 C. com. : forme juridique, capital, RCS **et ville**, SIRET, TVA.
    expect(issuerIdentityLine(ISSUER_MENTIONS)).toBe(
      "SARL au capital de 21 000,00 € · RCS Bourg-en-Bresse 380 569 012 · " +
        "SIRET 380 569 012 00020 · TVA FR73 380 569 012"
    );
  });

  it("n'invente pas la ville du RCS quand elle manque", () => {
    // La facture papier imprimait « RCS : 380569012 », sans ville : la mention etait
    // incomplete. On ne la complete pas d'office — on affiche ce qu'on a.
    const line = issuerIdentityLine({ ...ISSUER_MENTIONS, rcs_city: undefined });
    expect(line).toContain("RCS 380 569 012");
    expect(line).not.toContain("Bourg-en-Bresse");
  });

  it("prefere le SIRET au SIREN, qu'il contient deja", () => {
    const line = issuerIdentityLine(ISSUER_MENTIONS) as string;
    expect(line).toContain("SIRET 380 569 012 00020");
    expect(line).not.toContain("SIREN");
  });

  it("ne rend aucune ligne quand rien n'est parametre", () => {
    expect(issuerIdentityLine({})).toBeNull();
    expect(issuerIdentityLine({ company_name: "CROIX ROUSSE PRECISION" })).toBeNull();
  });

  it("degrade proprement sur une identite partielle", () => {
    // Une forme juridique sans capital reste une mention valable ; on ne tait pas tout
    // parce qu'une piece manque.
    expect(issuerIdentityLine({ legal_form: "SARL" })).toBe("SARL");
    expect(issuerIdentityLine({ share_capital: "21000.00" })).toBe("Capital social 21 000,00 €");
  });

  it("n'est plus repetee dans la carte « Émetteur »", () => {
    // L'identite legale vit dans le pied, sur toutes les pages. La reprendre dans la carte
    // la ferait figurer deux fois sur la meme page.
    const lines = partyLines(ISSUER_MENTIONS, { identifiers: false });
    expect(lines).toContain("CROIX ROUSSE PRECISION");
    expect(lines).toContain("Tél. 04 72 00 26 25");
    expect(lines.join("\n")).not.toContain("SIRET");
    expect(lines.join("\n")).not.toContain("TVA");
  });
});

describe("mentions de reglement", () => {
  it("porte les cinq mentions obligatoires", () => {
    const mentions = issuerLegalMentions(ISSUER_MENTIONS).join("\n");
    expect(mentions).toContain("Pénalités de retard : 12,5 % l'an");
    expect(mentions).toContain("art. L441-10 du code de commerce");
    expect(mentions).toContain("Indemnité forfaitaire pour frais de recouvrement : 40,00 € par facture");
    expect(mentions).toContain("art. D441-5 du code de commerce");
    expect(mentions).toContain("Escompte pour paiement anticipé : 1,5 % par mois");
    expect(mentions).toContain("TVA acquittée sur les encaissements");
    expect(mentions).toContain("Réserve de propriété : Nous nous réservons la propriété");
  });

  it("dit explicitement qu'aucun escompte n'est accordé", () => {
    // L'escompte est une mention obligatoire **meme en son absence** (art. L441-9). Un taux
    // vide ne doit pas se traduire par un silence.
    const mentions = issuerLegalMentions({
      ...ISSUER_MENTIONS,
      early_discount_rate: undefined,
      early_discount_basis: undefined,
    }).join("\n");
    expect(mentions).toContain("Escompte pour paiement anticipé : aucun escompte n'est accordé");
  });

  it("ne parle pas d'escompte quand aucune version de mentions n'est résolue", () => {
    // Hors periode de validite, on ne sait rien : ecrire « aucun escompte » serait une
    // affirmation inventee, pas une mention.
    const mentions = issuerLegalMentions({ company_name: "CROIX ROUSSE PRECISION" });
    expect(mentions).toEqual([]);
  });

  it("porte la franchise en base quand elle s'applique", () => {
    const mentions = issuerLegalMentions({
      ...ISSUER_MENTIONS,
      vat_on_receipts: undefined,
      vat_exempt_293b: true,
    }).join("\n");
    expect(mentions).toContain("TVA non applicable, article 293 B du code général des impôts");
    expect(mentions).not.toContain("TVA acquittée sur les encaissements");
  });

  it("supprime les zéros décimaux inutiles d'un taux", () => {
    // `numeric(6,3)` stocke `12.500` : la precision de stockage n'a pas a transparaitre.
    const mentions = issuerLegalMentions({ ...ISSUER_MENTIONS, late_penalty_rate: "12.000" }).join("\n");
    expect(mentions).toContain("Pénalités de retard : 12 % l'an");
  });

  it("reprend les mentions libres additionnelles", () => {
    const mentions = issuerLegalMentions({
      ...ISSUER_MENTIONS,
      extra_mentions: ["Membre d'une association agréée, le règlement par chèque est accepté."],
    });
    expect(mentions.at(-1)).toBe("Membre d'une association agréée, le règlement par chèque est accepté.");
  });
});

/** Texte dessine, espaces normalises : un retour a la ligne coupe les chaines longues. */
function flat(bytes: Buffer): string {
  return drawnText(bytes).replace(/\s+/g, " ");
}

describe("mentions legales — rendu reel", () => {
  it("scenario 7 (facture avec mentions) : toutes portees", async () => {
    const bytes = await renderFinanceDocument(FACTURE_MENTIONS);
    keep("66-facture-mentions-legales", bytes);

    const text = flat(bytes);
    expect(text).toContain("SARL au capital de 21 000,00 €");
    expect(text).toContain("RCS Bourg-en-Bresse 380 569 012");
    expect(text).toContain("SIRET 380 569 012 00020");
    expect(text).toContain("TVA FR73 380 569 012");
    expect(text).toContain("Pénalités de retard : 12,5 % l'an");
    expect(text).toContain("Indemnité forfaitaire pour frais de recouvrement : 40,00 € par facture");
    expect(text).toContain("Escompte pour paiement anticipé : 1,5 % par mois");
    expect(text).toContain("TVA acquittée sur les encaissements");
    expect(text).toContain("Nous nous réservons la propriété des marchandises");
  }, 60_000);

  it("scenario 8 (facture courte) : les mentions tiennent sans ouvrir de page", async () => {
    // Les mentions vivent dans la bande de pied, pas dans le flux : sur un document qui a
    // de la place, elles ne coutent aucune page. Sur un document deja au bord — comme le
    // gabarit `FACTURE`, a moins de 10 pt de la limite avant meme ce changement — la
    // seconde page vient du contenu, pas des mentions.
    const bytes = await renderFinanceDocument({
      ...FACTURE_MENTIONS,
      lines: [ligne()],
      dueDates: [{ dueDate: "2026-08-21", label: "30 jours net", amount: "8755.20" }],
      customerText: null,
    });
    keep("69-facture-mentions-courte", bytes);

    expect(drawnPages(bytes)).toHaveLength(1);
    const text = flat(bytes);
    expect(text).toContain("SARL au capital de 21 000,00 €");
    expect(text).toContain("Pénalités de retard : 12,5 % l'an");
    expect(text).toContain("Nous nous réservons la propriété des marchandises");
  }, 60_000);

  it("porte les coordonnées de règlement, qui permettent au client de payer", async () => {
    const text = flat(await renderFinanceDocument(FACTURE_MENTIONS));
    expect(text).toContain("RIB : FR76 3000 3024 9100 0200 0775 958");
    expect(text).toContain("BIC : SOGEFRPP");
  }, 60_000);

  it("n'affiche pas de coordonnées bancaires sur un avoir", async () => {
    // Un avoir ne se regle pas : y afficher un RIB serait une invitation a payer.
    const text = drawnText(await renderFinanceDocument({ ...AVOIR, issuer: ISSUER_MENTIONS }));
    expect(text).not.toContain("FR76 3000 3024 9100 0200 0775 958");
    // Les mentions obligatoires, elles, restent : un avoir est une piece fiscale.
    expect(text).toContain("SIRET 380 569 012 00020");
    expect(text).toContain("Pénalités de retard : 12,5 % l'an");
  }, 60_000);

  it("répète identité et mentions sur chacune des pages", async () => {
    // Une page detachee doit rester rattachable a son emetteur et rester opposable.
    const bytes = await renderFinanceDocument({
      ...FACTURE_MENTIONS,
      lines: Array.from({ length: 40 }, (_, index) =>
        ligne({ designation: `Composant usiné référence ${index + 1} — plan 46${index}-A indice B` })
      ),
    });
    keep("67-facture-mentions-volume", bytes);

    const pages = drawnPages(bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page).toContain("SIRET 380 569 012 00020");
      expect(page).toContain("Pénalités de retard : 12,5 % l'an");
      expect(page).toContain("Indemnité forfaitaire");
    }
  }, 90_000);

  it("le texte des mentions reste extractible du PDF", async () => {
    // Les mentions sont rendues fer a gauche et non justifiees : pdfkit justifie en
    // positionnant les mots, ce qui fait ressortir « Penalitesderetard:12,5% » a
    // l'extraction. Une mention legale doit rester lisible par une machine.
    const text = drawnText(await renderFinanceDocument(FACTURE_MENTIONS));
    expect(text).toContain("Pénalités de retard : 12,5 % l'an, exigibles de plein droit");
    expect(text).not.toMatch(/Pénalitésderetard/);
  }, 60_000);

  it("l'instantané fige fait foi, pas le paramétrage courant", async () => {
    // Une facture emise porte les mentions **en vigueur a son emission**. Rendue depuis un
    // instantane ancien, elle doit afficher l'ancien taux — sinon le versionnement ne sert
    // a rien et l'historique se retrouve reecrit.
    const bytes = await renderFinanceDocument({
      ...FACTURE_MENTIONS,
      issuer: { ...ISSUER_MENTIONS, late_penalty_rate: "9.750", legal_mentions_version: 0 },
    });
    const text = drawnText(bytes);
    expect(text).toContain("Pénalités de retard : 9,75 % l'an");
    expect(text).not.toContain("12,5 %");
  }, 60_000);

  it("n'invente aucune mention quand le référentiel n'en porte pas", async () => {
    // Etat d'avant le patch : ni identite legale, ni mentions. Le document doit rester
    // lisible et muet, jamais approximatif.
    const bytes = await renderFinanceDocument({
      ...FACTURE,
      issuer: { company_name: "CROIX ROUSSE PRECISION" },
    });
    keep("68-facture-sans-mentions", bytes);

    const text = drawnText(bytes);
    expect(text).toContain("CROIX ROUSSE PRECISION");
    expect(text).not.toContain("Pénalités de retard");
    expect(text).not.toContain("Indemnité forfaitaire");
    expect(text).not.toContain("Escompte");
    expect(text).not.toContain("au capital de");
    expect(drawnPages(bytes)).toHaveLength(1);
  }, 60_000);
});
