import { renderCerpDocument, type CerpLineRow } from "../../../shared/pdf/cerp-document";
import { formatDateFR, money, percent } from "../../../shared/pdf/format-fr";
import { issuerIdentityLine, issuerLegalMentions, type LegalParty } from "../../../shared/pdf/legal-mentions";
import type { AuthoritativePdfArchiveRecord } from "../../../shared/authoritative-documents/authoritative-document.types";

export type SupplierPurchaseOrderSnapshot = {
  type: "SUPPLIER_PURCHASE_ORDER";
  code: string;
  status: string;
  issued_at: string;
  supplier: {
    code: string | null; name: string | null;
    address?: { street: string | null; house_number: string | null; postal_code: string | null; city: string | null; country: string | null } | null;
  };
  currency: string;
  need_date: string | null;
  incoterm: string | null;
  payment_terms: string | null;
  transport_mode: string | null;
  public_comment: string | null;
  delivery_address: string | null;
  lines: Array<{
    position: number; reference: string | null; designation: string; unit: string | null;
    quantity: string; unit_price_ht: string | null; discount_pct: string | null;
    vat_pct: string | null; net_ht: string | null; need_date: string | null;
  }>;
  totals: { total_ht: string; total_discount: string; total_vat: string; freight_ht: string; total_ttc: string };
  issuer: LegalParty;
};

function snapshotOf(record: AuthoritativePdfArchiveRecord): SupplierPurchaseOrderSnapshot {
  const source = record.sourceSnapshot as Partial<SupplierPurchaseOrderSnapshot>;
  if (source.type !== "SUPPLIER_PURCHASE_ORDER" || !source.code || !Array.isArray(source.lines) || !source.totals || !source.issuer) {
    throw new Error("SUPPLIER_PO_SNAPSHOT_INVALID");
  }
  return source as SupplierPurchaseOrderSnapshot;
}

function businessAddressLines(address: SupplierPurchaseOrderSnapshot["supplier"]["address"]): string[] {
  if (!address) return [];
  return [
    [address.house_number, address.street].filter(Boolean).join(" ").trim(),
    [address.postal_code, address.city].filter(Boolean).join(" ").trim(),
    address.country ?? "",
  ].filter((line) => line.length > 0);
}

function archiveCreationDate(record: AuthoritativePdfArchiveRecord): Date {
  const value = new Date(record.createdAt);
  if (Number.isNaN(value.getTime())) throw new Error("SUPPLIER_PO_ARCHIVE_CREATED_AT_INVALID");
  return value;
}

/** Renders only data frozen in the archive snapshot — never a live PO row. */
export async function renderSupplierPurchaseOrderOfficialPdf(input: { archive: AuthoritativePdfArchiveRecord }): Promise<Buffer> {
  const source = snapshotOf(input.archive);
  const supplierName = source.supplier.name?.trim() || "Fournisseur";
  const supplierAddress = businessAddressLines(source.supplier.address);
  const draft = source.status.trim().toUpperCase() === "BROUILLON";
  const archivedAt = archiveCreationDate(input.archive);
  const rows: CerpLineRow[] = source.lines.map((line) => ({
    cells: {
      pos: String(line.position), reference: line.reference ?? "—", designation: line.designation,
      quantity: line.quantity, unit: line.unit ?? "—", price: line.unit_price_ht ? money(line.unit_price_ht, source.currency) : "—",
      vat: line.vat_pct ? percent(line.vat_pct) : "—", total: line.net_ht ? money(line.net_ht, source.currency) : "—",
    },
    meta: [line.need_date ? `Besoin : ${formatDateFR(line.need_date)}` : null, line.discount_pct ? `Remise : ${percent(line.discount_pct)}` : null].filter(Boolean).join(" · ") || null,
    metaColumn: "designation",
  }));
  return renderCerpDocument({
    documentType: "Bon de commande fournisseur", name: source.code, code: source.code,
    subtitle: `Version ${input.archive.documentVersion} · ${draft ? "Instantané de création" : `Émis le ${formatDateFR(source.issued_at)}`}`,
    status: source.status, monogramName: supplierName, generatedAt: formatDateFR(archivedAt.toISOString()),
    flag: draft ? "INTERNE / BROUILLON" : null,
    watermark: draft ? "INTERNE / BROUILLON" : null,
    footerNote: draft ? "Instantané interne GED — non opposable" : `Original GED · SHA-256 ${input.archive.snapshotSha256.slice(0, 16)}…`,
    legalIdentity: issuerIdentityLine(source.issuer), legalMentions: issuerLegalMentions(source.issuer),
    title: `Bon de commande fournisseur ${source.code}`, subject: draft ? "Instantané interne CERP — brouillon" : "Bon de commande fournisseur CERP",
    creationDate: archivedAt,
  }, (ctx) => {
    ctx.legalStrip([
      { label: "Fournisseur", value: supplierName }, { label: "Code fournisseur", value: source.supplier.code },
      { label: "Besoin", value: source.need_date ? formatDateFR(source.need_date) : null },
      { label: "Devise", value: source.currency },
    ]);
    if (supplierAddress.length) ctx.addressCards([{ caption: "Adresse fournisseur", lines: supplierAddress, accent: true }]);
    ctx.section("Conditions");
    const top = ctx.y;
    const middle = 38 + 260;
    const right = 38 + 410;
    const bottom = Math.max(
      ctx.field("Incoterm", source.incoterm, 38, 115),
      ctx.field("Règlement", source.payment_terms, middle, 145),
      ctx.field("Transport", source.transport_mode, right, 145)
    );
    ctx.y = Math.max(top + 34, bottom + 7);
    if (source.delivery_address) ctx.notesSection("Livraison", source.delivery_address);
    ctx.section("Lignes commandées");
    ctx.linesTable({
      columns: [
        { key: "pos", label: "N°", flex: 0.35, align: "right" }, { key: "reference", label: "Référence", flex: 1.05 },
        { key: "designation", label: "Désignation", flex: 2.5 }, { key: "quantity", label: "Qté", flex: 0.7, align: "right" },
        { key: "unit", label: "U", flex: 0.45 }, { key: "price", label: "PU HT", flex: 1, align: "right" },
        { key: "vat", label: "TVA", flex: 0.7, align: "right" }, { key: "total", label: "Total HT", flex: 1.1, align: "right" },
      ], rows, emptyLabel: "Aucune ligne active.",
    });
    ctx.section("Totaux");
    const totalTop = ctx.y;
    const subtotalBottom = Math.max(
      ctx.field("Total HT", money(source.totals.total_ht, source.currency), 38, 140),
      ctx.field("Remises", money(source.totals.total_discount, source.currency), 215, 140),
      ctx.field("Frais de port HT", money(source.totals.freight_ht, source.currency), 392, 127)
    );
    ctx.y = Math.max(totalTop + 34, subtotalBottom + 8);
    const totalBottom = Math.max(
      ctx.field("TVA", money(source.totals.total_vat, source.currency), 38, 190),
      ctx.field("Total TTC", money(source.totals.total_ttc, source.currency), 275, 244)
    );
    ctx.y = Math.max(ctx.y, totalBottom + 7);
    if (source.public_comment) ctx.notesSection("Instructions", source.public_comment);
  });
}
