import { renderCerpDocument, type CerpLineRow } from "../../../shared/pdf/cerp-document";
import { issuerIdentityLine, issuerLegalMentions } from "../../../shared/pdf/legal-mentions";
import { readGedEntityImageVersion } from "../../../shared/pdf/ged-entity-image";
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
  const currentDesign = archive.renderVersion === "client-profile-pdf-v3";
  const entityImage = source.entity_image
    ? await readGedEntityImageVersion({
        versionId: source.entity_image.ged_version_id,
        entityType: "CLIENT",
        entityId: archive.entityId,
      })
    : null;

  return renderCerpDocument({
    ...(currentDesign ? { designVersion: "structured-v5" as const, appearance: "clients-v3" as const } : {}),
    documentType: "Fiche client",
    name: currentDesign ? source.reference : source.entity_label,
    code: source.reference,
    subtitle: `Version GED v${archive.documentVersion} — données figées le ${createdAt.toLocaleDateString("fr-FR")}`,
    status,
    monogramName: source.entity_label,
    entityImage,
    generatedAt: createdAt.toLocaleDateString("fr-FR"),
    flag: blocked ? "CLIENT BLOQUÉ" : undefined,
    footerNote: `Fiche client GED — v${archive.documentVersion}`,
    legalIdentity: issuerIdentityLine(source.issuer) ?? "Croix Rousse Precision",
    legalMentions: issuerLegalMentions(source.issuer),
    title: `Fiche client ${source.reference} — ${source.entity_label}`,
    subject: "Fiche client consolidée, versionnée et archivée dans la GED",
    creationDate: createdAt,
  }, (ctx) => {
    if (currentDesign) ctx.fieldsGrid([{ label: "Raison sociale", value: source.entity_label }], 1);
    ctx.legalStrip([...source.summary]);
    for (const section of source.sections) {
      ctx.section(section.title);
      if (section.rows?.length) ctx.fieldsGrid(section.rows.map((row) => ({
        ...row,
        value: currentDesign && row.label.toLocaleLowerCase("fr-FR").includes("tva") && row.value
          ? row.value.replace(/\s/g, "").replace(/^(FR[A-Z0-9]{2})(\d{3})(\d{3})(\d{3})$/i, "$1 $2 $3 $4")
          : row.value,
      })), Math.min(3, section.rows.length));
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
