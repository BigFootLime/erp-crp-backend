import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildInternalCreationSnapshot } from "../shared/authoritative-documents/internal-creation-snapshot";
import { renderInternalCreationSnapshotPdf } from "../shared/authoritative-documents/internal-creation-snapshot-pdf";
import { renderCurrentTechnicalDocumentPdf } from "../shared/authoritative-documents/current-technical-document-pdf";
import type { AuthoritativePdfArchiveRecord } from "../shared/authoritative-documents/authoritative-document.types";

vi.mock("../config/database", () => ({ default: { query: () => { throw new Error("Fixture must not query database"); } } }));

describe("Old and new archived print editions", () => {
  it.each([
    ["stock-article", "STOCK_ARTICLE_CREATION_SNAPSHOT", "internal-creation-snapshot-v1", "Article stock"],
    ["piece-technique-version", "TECHNICAL_SHEET", "technical-sheet-v1", "Pièce technique"],
    ["ordre-fabrication", "OF_TRAVELER", "of-traveler-v2", "Fiche suiveuse"],
  ])("preserves the frozen source and page count for %s", async (entityType, documentKind, renderVersion, label) => {
    const archive: AuthoritativePdfArchiveRecord = {
      id: "11111111-1111-4111-8111-111111111111", entityType, entityId: "42", documentKind, documentVersion: 1, renderVersion,
      idempotencyKey: `${entityType}:42:fixture`, title: label, originalName: "fixture.pdf", sourceRevision: "fixture-1",
      sourceSnapshot: buildInternalCreationSnapshot({ entityLabel: label, reference: "STYLE-0042", issuer: { company_name: "CROIX ROUSSE PRECISION" },
        summary: [{ label: "Statut technique", value: "PUBLIE" }, { label: "Statut OF", value: "PLANIFIE" }],
        sections: [{ title: "Définition", rows: [{ label: "Désignation", value: "Bague de démonstration" }, { label: "Indice", value: "A" }, { label: "Quantité", value: "40 pièces" }] },
          { title: "Opérations", table: { columns: [{ key: "op", label: "Phase" }, { key: "designation", label: "Opération" }], rows: [{ op: "20", designation: "Découpe" }, { op: "30", designation: "Fraisage" }] } }],
      }),
      actorUserId: null, createdAt: "2026-10-19T10:00:00Z", snapshotSha256: "a".repeat(64), exactPdfSha256: null, exactPdfSizeBytes: null,
      pdfSha256: null, pdfSizeBytes: null, gedDocumentId: null, gedVersionId: null, archivedAt: null,
    };
    const frozen = JSON.stringify(archive);
    const render = documentKind === "STOCK_ARTICLE_CREATION_SNAPSHOT" ? renderInternalCreationSnapshotPdf : renderCurrentTechnicalDocumentPdf;
    const old = await render({ archive });
    const next = await render({ archive: { ...archive, renderVersion: `${renderVersion}+style-20261019` } });
    expect(JSON.stringify(archive)).toBe(frozen);
    expect(old.equals(await render({ archive }))).toBe(true);
    expect(old.equals(next)).toBe(false);
    expect((await PDFDocument.load(next)).getPageCount()).toBe((await PDFDocument.load(old)).getPageCount());
    if (process.env.CERP_PDF_REPLAY_PROOFS) {
      for (const [edition, bytes] of [["before", old], ["after", next]] as const) {
        const dir = path.join(process.env.CERP_PDF_REPLAY_PROOFS, `archives-${edition}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${entityType}.pdf`), bytes);
      }
    }
  });
});
