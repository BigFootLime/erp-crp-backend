import { renderCerpDocument, type CerpLineRow } from "../pdf/cerp-document";
import { issuerIdentityLine, issuerLegalMentions } from "../pdf/legal-mentions";
import { parseInternalCreationSnapshot } from "./internal-creation-snapshot-pdf";
import type { AuthoritativePdfArchiveRecord } from "./authoritative-document.types";

/** Separate renderer from creation receipts: existing archived editions keep their contract. */
export async function renderCurrentTechnicalDocumentPdf({
  archive,
}: {
  archive: AuthoritativePdfArchiveRecord;
}): Promise<Buffer> {
  const sheet = archive.documentKind === "TECHNICAL_SHEET";
  if (
    (!sheet && archive.documentKind !== "OF_TRAVELER") ||
    !(sheet ? ["technical-sheet-v1"] : ["of-traveler-v1", "of-traveler-v2"]).includes(archive.renderVersion)
  )
    throw new Error("TECHNICAL_DOCUMENT_RENDER_VERSION_UNSUPPORTED");
  const source = parseInternalCreationSnapshot(archive),
    created = new Date(archive.createdAt);
  if (Number.isNaN(created.getTime()))
    throw new Error("TECHNICAL_DOCUMENT_DATE_INVALID");
  const status =
    source.summary.find(
      (r) => r.label === (sheet ? "Statut technique" : "Statut OF"),
    )?.value ?? "Non renseigné";
  const draft = ["BROUILLON", "DRAFT", "INCOMPLETE"].includes(status);
  const obsolete = status === "OBSOLETE";
  const name = sheet ? "Fiche technique" : "Fiche suiveuse";
  return renderCerpDocument(
    {
      documentType: name,
      name: source.entity_label,
      code: source.reference,
       subtitle: `Édition GED v${archive.documentVersion} — données figées le ${created.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`,
      status,
      monogramName: source.entity_label,
       generatedAt: created.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }),
      flag: draft ? "BROUILLON" : obsolete ? "VERSION OBSOLÈTE" : undefined,
      watermark: draft ? "BROUILLON" : obsolete ? "OBSOLÈTE" : undefined,
      footerNote: `${name} — édition v${archive.documentVersion} — source SHA-256 ${archive.snapshotSha256.slice(0, 16)}…`,
      legalIdentity:
        issuerIdentityLine(source.issuer) ?? "Croix Rousse Precision",
      legalMentions: issuerLegalMentions(source.issuer),
      title: `${name} ${source.reference}`,
      subject: `Document technique interne archivé — ${source.entity_label}`,
      creationDate: created,
    },
    (ctx) => {
      ctx.legalStrip([...source.summary]);
      for (const section of source.sections) {
        ctx.section(section.title);
        if (section.rows?.length)
          ctx.fieldsGrid(section.rows, Math.min(3, section.rows.length));
        if (section.table) {
          const columns = section.table.columns.map((c) => ({
            key: c.key,
            label: c.label,
            flex: ["op", "ref", "designation", "title", "sha"].includes(c.key)
              ? 2
              : 1,
          }));
          const rows: CerpLineRow[] = section.table.rows.map((r) => ({
            cells: Object.fromEntries(
              section.table!.columns.map((c) => [c.key, r[c.key] ?? "—"]),
            ),
          }));
          ctx.linesTable({
            columns,
            rows,
            emptyLabel: "Aucune donnée enregistrée.",
          });
        }
        if (section.notes) ctx.notes(section.notes);
      }
    },
  );
}
