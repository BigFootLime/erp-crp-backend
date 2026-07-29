import {
  CONTENT_WIDTH,
  renderCerpDocument,
  type CerpAddressCard,
  type CerpDocumentContext,
  type CerpLineRow,
} from "../../../shared/pdf/cerp-document";
import { formatDateFR, money, percent } from "../../../shared/pdf/format-fr";
import { issuerIdentityLine, issuerLegalMentions, issuerPaymentDetails } from "../../../shared/pdf/legal-mentions";

// Reexportes : la mise en forme francaise est desormais partagee avec le bon de livraison
// et l'accuse de reception, qui portent les memes mentions legales.
export { formatDateFR, money, percent };

/**
 * Rendu unique des documents financiers CERP : facture et avoir.
 *
 * Ces deux pieces sont **fiscales**. Elles ne sont pas seulement envoyees au client : elles
 * font foi, sont conservees, et leur contenu est encadre par la loi. Le rendu est donc au
 * serveur (ADR-0042), et il porte la grammaire CERP comme les autres documents sortants.
 *
 * Trois chemins produisaient auparavant ces documents avec trois mises en page differentes —
 * dont deux pour la seule facture, l'une pour le brouillon et l'autre pour l'exemplaire legal
 * immuable. Un client pouvait recevoir un brouillon puis une facture d'aspect completement
 * different pour le meme montant.
 */

/** Partie d'un document financier : emetteur ou client, telle que figee dans l'instantane. */
export type FinanceParty = Record<string, unknown>;

export type FinanceTaxLine = {
  ratePercent: string;
  baseExTax: string;
  taxAmount: string;
};

export type FinanceDocumentLine = {
  designation: string;
  codePiece: string | null;
  quantity: string;
  unit: string | null;
  unitPriceExTax: string;
  discountPercent: string;
  taxRatePercent: string;
  totalExTax: string;
  taxAmount: string;
  totalInclTax: string;
};

export type FinanceDocumentTotals = {
  subtotalExTax: string;
  globalDiscountPercent: string;
  globalDiscountAmount: string;
  totalExTax: string;
  totalTax: string;
  totalInclTax: string;
};

export type FinanceDocumentInput = {
  kind: "FACTURE" | "AVOIR";
  /** Numero legal, ou reference de brouillon si le document n'est pas encore emis. */
  number: string;
  /** `true` tant que le document n'est pas emis : il doit alors le dire. */
  draft: boolean;
  issueDate: string;
  currency: string;
  issuer: FinanceParty;
  client: FinanceParty;
  lines: FinanceDocumentLine[];
  totals: FinanceDocumentTotals;
  dueDates: Array<{ dueDate: string; label: string; amount: string }>;
  /** Avoir : facture corrigee et motif. */
  correctedInvoice?: string | null;
  reasonCode?: string | null;
  reason?: string | null;
  /** Texte destine au client. Jamais le commentaire interne. */
  customerText?: string | null;
  /** Empreinte de l'instantane immuable, quand le document est emis. */
  snapshotUuid?: string | null;
  draftReference?: string | null;
};

function clean(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return s ? s : null;
}

/** Premiere valeur non vide parmi plusieurs cles possibles. L'instantane est libre de forme. */
function pick(source: FinanceParty, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = clean(source[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Identite d'une partie, en lignes.
 *
 * Sur une facture, l'identite du vendeur et celle de l'acheteur sont des mentions
 * **obligatoires** : denomination, adresse, SIRET, numero de TVA intracommunautaire. On lit
 * l'instantane de facon defensive — sa forme appartient au referentiel — et on n'affiche que
 * ce qui existe reellement. Une mention absente n'est jamais remplacee par un substitut.
 *
 * ## Emetteur et client ne portent pas leur identite au meme endroit
 *
 * L'acheteur n'a qu'un seul emplacement sur le document : sa carte. Ses identifiants y
 * figurent donc.
 *
 * Le vendeur, lui, porte son identite legale dans le **pied de page**, sur toutes les pages
 * — forme juridique, capital, RCS et ville, SIRET, TVA. C'est la disposition de la facture
 * papier de l'entreprise, et c'est la seule qui garantisse la mention sur une page detachee.
 * La repeter dans la carte « Emetteur » la ferait apparaitre deux fois sur la meme page.
 * D'ou `identifiers: false` pour l'emetteur, pose par `partyCards()`.
 */
export function partyLines(party: FinanceParty, options: { identifiers?: boolean } = {}): string[] {
  const withIdentifiers = options.identifiers ?? true;
  const nested =
    party.billing_address && typeof party.billing_address === "object"
      ? (party.billing_address as FinanceParty)
      : {};

  const streetFromNested = [pick(nested, "house_number"), pick(nested, "street")].filter(Boolean).join(" ");
  const cityLine = [
    pick(party, "postal_code", "code_postal") ?? pick(nested, "postal_code"),
    pick(party, "city", "ville") ?? pick(nested, "city"),
  ]
    .filter(Boolean)
    .join(" ");

  const phone = pick(party, "phone", "telephone");
  const identity = [
    pick(party, "company_name", "name", "raison_sociale", "biller_name"),
    pick(party, "address_line_1", "address", "adresse") ?? (streetFromNested || null),
    pick(party, "address_line_2", "adresse_complement") ?? pick(nested, "address_complement"),
    cityLine || null,
    pick(party, "country", "pays") ?? pick(nested, "country"),
    phone ? `Tél. ${phone}` : null,
  ];

  const legal = withIdentifiers
    ? [
        pick(party, "siret") ? `SIRET ${pick(party, "siret")}` : null,
        pick(party, "siren") ? `SIREN ${pick(party, "siren")}` : null,
        pick(party, "rcs_number", "rcs")
          ? pick(party, "rcs_city")
            ? `RCS ${pick(party, "rcs_city")} ${pick(party, "rcs_number", "rcs")}`
            : `RCS ${pick(party, "rcs_number", "rcs")}`
          : null,
        pick(party, "vat_number", "numero_tva", "tva_intracommunautaire")
          ? `TVA ${pick(party, "vat_number", "numero_tva", "tva_intracommunautaire")}`
          : null,
        pick(party, "capital_social") ? `Capital ${pick(party, "capital_social")}` : null,
      ]
    : [];

  return [...identity, ...legal].filter((line): line is string => Boolean(line));
}

/**
 * Ventilation de la TVA par taux.
 *
 * Mention **obligatoire** sur une facture : pour chaque taux applique, la base hors taxes et
 * le montant de taxe correspondant. Elle est entierement derivee des lignes — aucun montant
 * n'est recalcule, les chaines viennent telles quelles du referentiel et sont sommees en
 * centimes pour eviter toute derive en virgule flottante.
 */
export function taxBreakdown(lines: FinanceDocumentLine[]): FinanceTaxLine[] {
  const toCents = (value: string): number => {
    const n = Number.parseFloat(String(value).replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  };
  const fromCents = (cents: number): string => (cents / 100).toFixed(2);

  const byRate = new Map<string, { base: number; tax: number }>();
  for (const line of lines) {
    const rate = clean(line.taxRatePercent) ?? "0";
    const bucket = byRate.get(rate) ?? { base: 0, tax: 0 };
    bucket.base += toCents(line.totalExTax);
    bucket.tax += toCents(line.taxAmount);
    byRate.set(rate, bucket);
  }

  return [...byRate.entries()]
    .sort((a, b) => Number.parseFloat(a[0]) - Number.parseFloat(b[0]))
    .map(([ratePercent, sums]) => ({
      ratePercent,
      baseExTax: fromCents(sums.base),
      taxAmount: fromCents(sums.tax),
    }));
}

/**
 * Recapitulatif : ventilation de la TVA a gauche, totaux a droite.
 *
 * Les deux occupent la meme bande. Empiles, ils poussaient une facture de deux lignes sur une
 * seconde page presque vide — et c'est aussi la disposition d'usage sur une facture.
 */
function summaryBlock(
  ctx: CerpDocumentContext,
  taxes: FinanceTaxLine[],
  totals: Array<{ label: string; value: string; strong?: boolean }>,
  currency: string
): void {
  const gap = 24;
  const totalsWidth = 226;
  const taxWidth = CONTENT_WIDTH - totalsWidth - gap;
  const taxX = 38;
  const totalsX = 38 + CONTENT_WIDTH - totalsWidth;

  const taxHeight = 14 + Math.max(1, taxes.length) * 14;
  const totalsHeight = totals.reduce((sum, row) => sum + (row.strong ? 18 : 15), 0);

  ctx.y += 12;
  ctx.ensureSpace(Math.max(taxHeight, totalsHeight) + 8);
  const top = ctx.y;

  // ── Ventilation de la TVA : mention obligatoire, base et taxe pour chaque taux applique.
  const cols = [
    { label: "Taux", w: taxWidth * 0.22, align: "left" as const },
    { label: "Base HT", w: taxWidth * 0.39, align: "right" as const },
    { label: "Montant TVA", w: taxWidth * 0.39, align: "right" as const },
  ];
  ctx.doc.font("Helvetica").fontSize(6.9).fillColor("#6E7681");
  let colX = taxX;
  for (const col of cols) {
    ctx.text(col.label.toUpperCase(), colX, top, { width: col.w - 6, align: col.align, characterSpacing: 0.75 });
    colX += col.w;
  }

  ctx.doc.save();
  ctx.doc.lineWidth(0.8).strokeColor("#101418");
  ctx.doc.moveTo(taxX, top + 11).lineTo(taxX + taxWidth, top + 11).stroke();
  ctx.doc.restore();

  let taxY = top + 16;
  const rows = taxes.length ? taxes : null;
  if (!rows) {
    ctx.doc.font("Helvetica").fontSize(9.5).fillColor("#6E7681");
    ctx.text("Aucune taxe applicable.", taxX, taxY, { width: taxWidth });
    taxY += 14;
  } else {
    for (const tax of rows) {
      const cells = [percent(tax.ratePercent), money(tax.baseExTax, currency), money(tax.taxAmount, currency)];
      colX = taxX;
      cells.forEach((cell, index) => {
        ctx.doc
          .font(index === 0 ? "Helvetica-Bold" : "Helvetica")
          .fontSize(9)
          .fillColor("#101418");
        ctx.text(cell, colX, taxY, { width: cols[index].w - 6, align: cols[index].align });
        colX += cols[index].w;
      });
      taxY += 14;
    }
  }

  // ── Totaux.
  let totalsY = top;
  for (const row of totals) {
    ctx.doc
      .font(row.strong ? "Helvetica-Bold" : "Helvetica")
      .fontSize(row.strong ? 11 : 9.5)
      .fillColor("#101418");
    if (row.strong) {
      ctx.doc.save();
      ctx.doc.lineWidth(0.8).strokeColor("#B90101");
      ctx.doc.moveTo(totalsX, totalsY - 4).lineTo(totalsX + totalsWidth, totalsY - 4).stroke();
      ctx.doc.restore();
    }
    ctx.text(row.label, totalsX, totalsY, { width: totalsWidth - 104 });
    ctx.text(row.value, totalsX + totalsWidth - 104, totalsY, { width: 104, align: "right" });
    totalsY += row.strong ? 18 : 15;
  }

  ctx.y = Math.max(taxY, totalsY);
  ctx.doc.fillColor("#101418");
}

function partyCards(input: FinanceDocumentInput): CerpAddressCard[] {
  return [
    {
      caption: "Émetteur",
      // Les identifiants legaux de l'emetteur sont dans le pied, sur toutes les pages.
      lines: partyLines(input.issuer, { identifiers: false }),
      accent: true,
      emptyLabel: "Non renseigné",
    },
    {
      caption: input.kind === "AVOIR" ? "Client crédité" : "Client facturé",
      lines: partyLines(input.client),
      emptyLabel: "Non renseigné",
    },
  ];
}

function documentLines(input: FinanceDocumentInput): CerpLineRow[] {
  return input.lines.map((line) => {
    const details = [
      clean(line.codePiece),
      clean(line.unit) ? `Unité : ${line.unit}` : null,
      clean(line.discountPercent) && Number.parseFloat(line.discountPercent) !== 0
        ? `Remise ${percent(line.discountPercent)}`
        : null,
    ].filter(Boolean);

    return {
      metaColumn: "designation",
      meta: details.length ? details.join(" · ") : null,
      cells: {
        designation: line.designation,
        quantite: clean(line.quantity) ?? "—",
        pu: money(line.unitPriceExTax, input.currency),
        tva: percent(line.taxRatePercent),
        ht: money(line.totalExTax, input.currency),
      },
    };
  });
}

/** Rattachement de l'exemplaire a l'instantane conserve, quand il existe. */
function traceabilityNote(input: FinanceDocumentInput): string | null {
  const parts = [
    clean(input.snapshotUuid) ? `Instantané immuable ${input.snapshotUuid}` : null,
    clean(input.draftReference) ? `Référence brouillon ${input.draftReference}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export async function renderFinanceDocument(input: FinanceDocumentInput): Promise<Buffer> {
  const isAvoir = input.kind === "AVOIR";
  const documentType = isAvoir ? "Avoir" : "Facture";
  const clientName = pick(input.client, "company_name", "name", "raison_sociale") ?? "Client";
  const taxes = taxBreakdown(input.lines);

  return renderCerpDocument(
    {
      documentType,
      name: input.number,
      code: formatDateFR(input.issueDate),
      subtitle: clientName,
      // Un brouillon doit se denoncer comme tel : sans cela, imprime, il passerait pour une
      // piece emise — et une facture non emise n'a aucune valeur fiscale.
      status: input.draft ? "Brouillon" : "Émis",
      flag: input.draft ? "Ne pas transmettre" : null,
      monogramName: clientName,
      generatedAt: formatDateFR(input.issueDate),
      generatedBy: null,
      title: `${documentType} ${input.number}`,
      subject: `${documentType} CERP`,
      // Tracabilite de l'exemplaire, portee par toutes les pages : c'est ce qui permet de
      // rattacher un PDF retrouve chez le client a l'instantane immuable conserve.
      footerNote: traceabilityNote(input),
      // Identite legale de l'emetteur : mention obligatoire, portee par toutes les pages.
      // Elle est lue dans l'instantane fige, donc elle reflete ce qui etait en vigueur a
      // l'emission — pas ce qui est parametre aujourd'hui.
      legalIdentity: issuerIdentityLine(input.issuer),
      // Penalites de retard, indemnite forfaitaire de recouvrement, escompte, regime de TVA
      // et reserve de propriete. Dans la bande de pied, comme sur la facture papier : elles
      // ne doivent jamais couter une page au contenu.
      //
      // Les coordonnees bancaires ferment la bande. Ce n'est pas une mention obligatoire,
      // mais c'est ce qui permet au client de payer, et un avoir ne se regle pas — y
      // afficher un RIB serait une invitation a payer. En section titree dans le flux,
      // elles coutaient 54 pt et faisaient basculer une facture de deux lignes sur une
      // seconde page ; ici, une ligne suffit.
      legalMentions: [
        ...issuerLegalMentions(input.issuer),
        ...(isAvoir ? [] : [issuerPaymentDetails(input.issuer)].filter((line): line is string => Boolean(line))),
      ],
      creationDate: new Date(`${input.issueDate.slice(0, 10)}T12:00:00.000Z`),
    },
    (ctx) => {
      ctx.legalStrip(
        isAvoir
          ? [
              { label: "Numéro d'avoir", value: input.number },
              { label: "Date d'émission", value: formatDateFR(input.issueDate) },
              { label: "Facture corrigée", value: clean(input.correctedInvoice) },
              { label: "Devise", value: input.currency },
            ]
          : [
              { label: "Numéro de facture", value: input.number },
              { label: "Date d'émission", value: formatDateFR(input.issueDate) },
              { label: "Échéance", value: input.dueDates.length ? formatDateFR(input.dueDates.at(-1)?.dueDate) : null },
              { label: "Devise", value: input.currency },
            ]
      );

      ctx.section("Parties", { cohesion: 90 });
      ctx.addressCards(partyCards(input));

      if (isAvoir && clean(input.reason)) {
        ctx.notesSection(
          "Motif",
          clean(input.reasonCode) ? `${input.reasonCode} — ${input.reason}` : (input.reason as string)
        );
      }

      ctx.section(isAvoir ? "Lignes créditées" : "Lignes facturées", { cohesion: 104 });
      ctx.linesTable({
        columns: [
          { key: "designation", label: "Désignation", flex: 4.6 },
          { key: "quantite", label: "Quantité", flex: 1.1, align: "right" },
          { key: "pu", label: "PU HT", flex: 1.7, align: "right" },
          { key: "tva", label: "TVA", flex: 0.9, align: "right" },
          { key: "ht", label: "Total HT", flex: 1.7, align: "right" },
        ],
        rows: documentLines(input),
        emptyLabel: isAvoir ? "Aucune ligne créditée." : "Aucune ligne facturée.",
      });

      const hasGlobalDiscount =
        clean(input.totals.globalDiscountAmount) && Number.parseFloat(input.totals.globalDiscountAmount) !== 0;

      ctx.section("Récapitulatif", { cohesion: 74 });
      summaryBlock(
        ctx,
        taxes,
        [
          ...(hasGlobalDiscount
            ? [
                { label: "Sous-total HT", value: money(input.totals.subtotalExTax, input.currency) },
                {
                  label: `Remise globale (${percent(input.totals.globalDiscountPercent)})`,
                  value: `- ${money(input.totals.globalDiscountAmount, input.currency)}`,
                },
              ]
            : []),
          { label: "Total HT", value: money(input.totals.totalExTax, input.currency) },
          { label: "TVA", value: money(input.totals.totalTax, input.currency) },
          {
            label: isAvoir ? "Total TTC à créditer" : "Total TTC",
            value: money(input.totals.totalInclTax, input.currency),
            strong: true,
          },
        ],
        input.currency
      );

      if (!isAvoir && input.dueDates.length) {
        ctx.section("Échéances de règlement", { cohesion: 60 });
        ctx.linesTable({
          columns: [
            { key: "date", label: "Échéance", flex: 1.6 },
            { key: "label", label: "Libellé", flex: 4 },
            { key: "montant", label: "Montant", flex: 2, align: "right" },
          ],
          rows: input.dueDates.map((due) => ({
            metaColumn: "date",
            cells: {
              date: formatDateFR(due.dueDate),
              label: clean(due.label) ?? "—",
              montant: money(due.amount, input.currency),
            },
          })),
          emptyLabel: "Aucune échéance.",
        });
      }

      if (clean(input.customerText)) {
        ctx.notesSection("Informations client", input.customerText as string);
      }

    }
  );
}
