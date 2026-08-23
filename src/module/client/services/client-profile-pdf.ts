import { renderCerpDocument, type CerpLineRow } from "../../../shared/pdf/cerp-document";
import { issuerIdentityLine, issuerLegalMentions } from "../../../shared/pdf/legal-mentions";
import type { AuthoritativePdfArchiveRecord } from "../../../shared/authoritative-documents/authoritative-document.types";
import { parseInternalCreationSnapshot } from "../../../shared/authoritative-documents/internal-creation-snapshot-pdf";

function summaryValue(summary: ReadonlyArray<{ label: string; value: string | null }>, label: string): string | null {
  return summary.find((item) => item.label.localeCompare(label, "fr", { sensitivity: "base" }) === 0)?.value ?? null;
}

/**
 * Renders the current, consolidated client record. Its archive kind and GED
 * classification are distinct from the non-opposable creation receipt even
 * though both reuse the same strict server-composed section grammar.
 */
export async function renderClientProfilePdf({ archive }: { archive: AuthoritativePdfArchiveRecord }): Promise<Buffer> {
  const source = parseInternalCreationSnapshot(archive);
  const createdAt = new Date(archive.createdAt);
  if (Number.isNaN(createdAt.getTime())) throw new Error("CLIENT_PROFILE_CREATED_AT_INVALID");

  const status = summaryValue(source.summary, "Statut") ?? "Client";
  const blocked = summaryValue(source.summary, "Bloqué")?.toLocaleLowerCase("fr-FR") === "oui";

  return renderCerpDocument({
    documentType: "Fiche client",
    name: source.entity_label,
    code: source.reference,
    subtitle: `Version GED v${archive.documentVersion} — données figées le ${createdAt.toLocaleDateString("fr-FR")}`,
    status,
    monogramName: source.entity_label,
    generatedAt: createdAt.toLocaleDateString("fr-FR"),
    flag: blocked ? "CLIENT BLOQUÉ" : undefined,
    footerNote: `Fiche client GED — v${archive.documentVersion} — SHA-256 ${archive.snapshotSha256.slice(0, 16)}…`,
    legalIdentity: issuerIdentityLine(source.issuer) ?? "Croix Rousse Precision",
    legalMentions: issuerLegalMentions(source.issuer),
    title: `Fiche client ${source.reference} — ${source.entity_label}`,
    subject: "Fiche client consolidée, versionnée et archivée dans la GED",
    creationDate: createdAt,
  }, (ctx) => {
    ctx.legalStrip([...source.summary]);
    for (const section of source.sections) {
      ctx.section(section.title);
      if (section.rows?.length) ctx.fieldsGrid(section.rows, Math.min(3, section.rows.length));
      if (section.table) {
        const columns = section.table.columns.map((column) => ({ key: column.key, label: column.label, flex: 1 }));
        const rows: CerpLineRow[] = section.table.rows.map((row) => ({
          cells: Object.fromEntries(section.table!.columns.map((column) => [column.key, row[column.key] ?? "—"])),
        }));
        ctx.linesTable({ columns, rows, emptyLabel: "Aucune donnée." });
      }
      if (section.notes) ctx.notes(section.notes);
    }
  });
}
