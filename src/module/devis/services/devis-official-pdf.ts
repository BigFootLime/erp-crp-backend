import { renderCerpDocument, type CerpLineRow } from "../../../shared/pdf/cerp-document";
import { formatDateFR, money, percent } from "../../../shared/pdf/format-fr";
import { issuerIdentityLine, issuerLegalMentions, type LegalParty } from "../../../shared/pdf/legal-mentions";
import type { AuthoritativePdfArchiveRecord } from "../../../shared/authoritative-documents/authoritative-document.types";

type DevisOfficialSnapshot = {
  type: "CUSTOMER_QUOTE"; number: string; status: string; issued_at: string; valid_until: string | null;
  version: string;
  customer: {
    code?: string | null; name: string | null;
    address?: { name: string | null; street: string | null; house_number: string | null; postal_code: string | null; city: string | null; country: string | null } | null;
  };
  currency: string; public_comment: string | null;
  lines: Array<{ position: number; reference: string | null; designation: string; quantity: string; unit: string | null; unit_price_ht: string; discount_pct: string | null; vat_pct: string | null; total_ht: string; total_ttc: string }>;
  totals: { total_ht: string; total_ttc: string; global_discount_pct: string | null };
  issuer: LegalParty;
};

function parseSnapshot(archive: AuthoritativePdfArchiveRecord): DevisOfficialSnapshot {
  const source = archive.sourceSnapshot as Partial<DevisOfficialSnapshot>;
  if (source.type !== "CUSTOMER_QUOTE" || !source.number || !Array.isArray(source.lines) || !source.totals || !source.issuer) throw new Error("DEVIS_OFFICIAL_SNAPSHOT_INVALID");
  return source as DevisOfficialSnapshot;
}

function businessAddressLines(address: DevisOfficialSnapshot["customer"]["address"]): string[] {
  if (!address) return [];
  return [
    address.name ?? "",
    [address.house_number, address.street].filter(Boolean).join(" ").trim(),
    [address.postal_code, address.city].filter(Boolean).join(" ").trim(),
    address.country ?? "",
  ].filter((line) => line.length > 0);
}

function archiveCreationDate(record: AuthoritativePdfArchiveRecord): Date {
  const value = new Date(record.createdAt);
  if (Number.isNaN(value.getTime())) throw new Error("DEVIS_ARCHIVE_CREATED_AT_INVALID");
  return value;
}

export async function renderDevisOfficialPdf({ archive }: { archive: AuthoritativePdfArchiveRecord }): Promise<Buffer> {
  const source = parseSnapshot(archive);
  const customer = source.customer.name?.trim() || "Client";
  const customerAddress = businessAddressLines(source.customer.address);
  const draft = source.status.trim().toUpperCase() === "BROUILLON";
  const archivedAt = archiveCreationDate(archive);
  const rows: CerpLineRow[] = source.lines.map((line) => ({
    cells: { pos: String(line.position), ref: line.reference ?? "—", designation: line.designation, quantity: line.quantity, unit: line.unit ?? "—", price: money(line.unit_price_ht, source.currency), vat: line.vat_pct ? percent(line.vat_pct) : "—", total: money(line.total_ht, source.currency) },
    meta: line.discount_pct ? `Remise : ${percent(line.discount_pct)}` : null, metaColumn: "designation",
  }));
  return renderCerpDocument({
    documentType: "Devis", name: source.number, code: source.number,
    subtitle: `Version ${archive.documentVersion} · ${draft ? "Instantané de création" : `Émis le ${formatDateFR(source.issued_at)}`}`,
    status: source.status, monogramName: customer, generatedAt: formatDateFR(archivedAt.toISOString()),
    flag: draft ? "INTERNE / BROUILLON" : null,
    watermark: draft ? "INTERNE / BROUILLON" : null,
    footerNote: draft ? "Instantané interne GED — non opposable" : `Original GED · SHA-256 ${archive.snapshotSha256.slice(0, 16)}…`,
    legalIdentity: issuerIdentityLine(source.issuer), legalMentions: issuerLegalMentions(source.issuer),
    title: `Devis ${source.number}`, subject: draft ? "Instantané interne CERP — brouillon" : "Devis CERP", creationDate: archivedAt,
  }, (ctx) => {
    ctx.legalStrip([
      { label: "Client", value: customer }, { label: "Code client", value: source.customer.code ?? null }, { label: "Validité", value: source.valid_until ? formatDateFR(source.valid_until) : null },
      { label: "Statut", value: source.status }, { label: "Devise", value: source.currency },
    ]);
    if (customerAddress.length) ctx.addressCards([{ caption: "Adresse de facturation", lines: customerAddress, accent: true }]);
    ctx.section("Prestations proposées");
    ctx.linesTable({ columns: [
      { key: "pos", label: "N°", flex: .35, align: "right" }, { key: "ref", label: "Référence", flex: 1 }, { key: "designation", label: "Désignation", flex: 2.7 },
      { key: "quantity", label: "Qté", flex: .65, align: "right" }, { key: "unit", label: "U", flex: .4 }, { key: "price", label: "PU HT", flex: 1, align: "right" },
      { key: "vat", label: "TVA", flex: .7, align: "right" }, { key: "total", label: "Total HT", flex: 1.1, align: "right" },
    ], rows, emptyLabel: "Aucune ligne." });
    ctx.section("Synthèse financière");
    const top = ctx.y;
    const bottom = Math.max(
      ctx.field("Total HT", money(source.totals.total_ht, source.currency), 38, 135),
      ctx.field("Remise globale", source.totals.global_discount_pct ? percent(source.totals.global_discount_pct) : "—", 208, 135),
      ctx.field("Total TTC", money(source.totals.total_ttc, source.currency), 416, 140),
    );
    ctx.y = Math.max(top + 34, bottom + 7);
    if (source.public_comment) ctx.notesSection("Conditions et observations", source.public_comment);
  });
}
