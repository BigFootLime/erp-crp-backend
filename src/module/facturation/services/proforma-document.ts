import { renderCerpDocument } from "../../../shared/pdf/cerp-document";
import { renderWorkshopBoxes, renderWorkshopTable } from "../../../shared/pdf/workshop-document-blocks";
import { money, quantity, rate, unitPrice } from "../../../shared/pdf/format-fr";
import { issuerIdentityLine } from "../../../shared/pdf/legal-mentions";
import { formatDecimal, moneyToCents, parseDecimal } from "../domain/decimal-money";
import type { ProformaPreview } from "../types/proforma.types";
import { partyLines } from "./finance-document-render";

export type ProformaDocumentSnapshot = {
  document_type: "PROFORMA";
  id: string;
  reference: string;
  issued_at: string;
  issuer_snapshot: Record<string, unknown>;
  preview: ProformaPreview;
  fiscal_invoice_created: false;
  template_version: "proforma/1.1";
};

/** Only frozen commercial facts are printed; payment coverage is a separate live read. */
export async function renderProformaDocument(snapshot: ProformaDocumentSnapshot, options: { example?: boolean } = {}): Promise<Buffer> {
  const issuedAt = new Date(snapshot.issued_at);
  if (!Number.isFinite(issuedAt.getTime()) || snapshot.document_type !== "PROFORMA" || snapshot.fiscal_invoice_created !== false) {
    throw new Error("PROFORMA_DOCUMENT_SOURCE_INVALID");
  }
  const preview = snapshot.preview;
  const date = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris" }).format(issuedAt);
  const total = preview.company_totals.reduce((sum, company) => sum + moneyToCents(company.total_incl_tax), 0n);
  return renderCerpDocument({
    designVersion: "structured-v5", documentType: "Proforma", name: snapshot.reference, code: snapshot.reference,
    status: "Demande de règlement", generatedAt: date, creationDate: issuedAt,
    watermark: options.example ? "EXEMPLE" : null,
    title: `Proforma - ${snapshot.reference}`, subject: "Répartition commerciale des affaires de livraison",
    legalIdentity: issuerIdentityLine(snapshot.issuer_snapshot),
    footerNote: "Document commercial - ne constitue pas une facture fiscale",
  }, ctx => {
    renderWorkshopBoxes(ctx, [
      { title: "Émetteur", fields: [{ label: "Coordonnées", value: partyLines(snapshot.issuer_snapshot, { identifiers: false }).join("\n") }] },
      { title: "Client destinataire", fields: [
        { label: "Code client", value: preview.client_snapshot.client_code },
        { label: "Coordonnées", value: partyLines(preview.client_snapshot, { identifiers: false }).join("\n") },
      ] },
    ], { compact: true });
    renderWorkshopTable(ctx, { title: "Répartition des règlements", bodySize: 9, padding: 6, columns: [
      { key: "company", label: "Société facturée", flex: 3.5, firstLineBold: true },
      { key: "ht", label: "Total HT", flex: 1, align: "right" },
      { key: "vat", label: "TVA", flex: 1, align: "right" },
      { key: "ttc", label: "Montant TTC", flex: 1.25, bold: true, align: "right" },
    ], rows: preview.company_totals.map(company => ({ cells: {
      company: company.company_name, ht: money(company.total_ex_tax, preview.currency),
      vat: money(company.tax_amount, preview.currency), ttc: money(company.total_incl_tax, preview.currency),
    } })) });
    ctx.notes(`Total de la proforma : ${money(formatDecimal(total, 2), preview.currency)}. Chaque société règle la part qui lui est attribuée.`);
    for (const company of preview.company_totals) {
      if (preview.company_totals.length > 1) ctx.newPage();
      const selected = preview.affairs.flatMap(affair => affair.billing_parts.filter(part => part.billed_client_id === company.billed_client_id)
        .map(part => ({ affair, part })));
      if (!selected.length) throw new Error("PROFORMA_DOCUMENT_BILLING_PART_MISSING");
      const party = selected[0]!.part.billed_client_snapshot;
      const allocatedQuantity = selected.reduce((sum, { part }) => sum + parseDecimal(part.quantity, 3, "Quantité attribuée"), 0n);
      renderWorkshopBoxes(ctx, [
        { title: "Société facturée", fields: [
          { label: "Code client", value: party.client_code },
          { label: "Coordonnées", value: partyLines(party).join("\n") },
        ] },
        { title: "Part à régler", columns: 2, fields: [
          { label: "Quantité attribuée", value: quantity(formatDecimal(allocatedQuantity, 3)), prominent: true },
          { label: "Montant TTC", value: money(company.total_incl_tax, preview.currency), prominent: true },
          { label: "Total HT", value: money(company.total_ex_tax, preview.currency) },
          { label: "TVA", value: money(company.tax_amount, preview.currency) },
        ] },
      ], { compact: true });
      renderWorkshopTable(ctx, { title: "Articles et affaires", bodySize: 9, padding: 6, columns: [
        { key: "article", label: "Article / commande / affaire", flex: 3.2, firstLineBold: true },
        { key: "qty", label: "Quantité", flex: 0.8, align: "right" },
        { key: "price", label: "PU HT", flex: 1, align: "right" },
        { key: "discount", label: "Remises", flex: 1 },
        { key: "vat", label: "TVA", flex: 0.7, align: "right" },
        { key: "net", label: "HT net", flex: 1, bold: true, align: "right" },
      ], rows: selected.map(({ affair, part }) => {
        const source = affair.source_snapshot;
        const order = source.customer_order_reference || source.order_reference;
        const compactRate = (value: string) => rate(value)?.replace(/\s+(?=%$)/, "") ?? "";
        const discounts = [parseDecimal(part.discount_percent, 4, "Remise ligne") > 0n ? `Ligne ${compactRate(part.discount_percent)}` : null,
          parseDecimal(part.global_discount_percent, 4, "Remise commande") > 0n ? `Cde ${compactRate(part.global_discount_percent)}` : null].filter(Boolean);
        return { cells: {
          article: [source.code_piece, source.designation, order ? `Commande ${order}` : null,
            source.affaire_reference ? `Affaire ${source.affaire_reference}` : null].filter(Boolean).join("\n"),
          qty: `${quantity(part.quantity)}${source.unit ? ` ${source.unit}` : ""}`, price: unitPrice(part.unit_price_ex_tax, preview.currency),
          discount: discounts.join("\n") || "-", vat: rate(part.tax_rate_percent) ?? "", net: money(part.total_ex_tax, preview.currency),
        }, continuationLabel: `Suite - ${source.code_piece || source.designation || "article"}` };
      }) });
      ctx.notes("Les montants nets comprennent les remises de ligne et de commande affichées.");
    }
  });
}

/** Used only for stored snapshots; the archive worker prefers exact issued bytes. */
export const renderProformaOfficialPdf: import("../../../shared/authoritative-documents/authoritative-document.types").AuthoritativePdfProducer = async ({ archive }) => {
  const snapshot = archive.sourceSnapshot as unknown as ProformaDocumentSnapshot;
  if (archive.entityType !== "proforma" || archive.documentKind !== "CUSTOMER_PROFORMA" || snapshot.id !== archive.entityId
    || snapshot.template_version !== "proforma/1.1") throw new Error("AUTHORITATIVE_PDF_PROFORMA_SOURCE_INVALID");
  return renderProformaDocument(snapshot);
};
