/* Archive and prove the exact legal PDF of one TEST-only fixture invoice. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pool from "../../src/config/database";
import { readOfficialPdfBytes } from "../../src/shared/authoritative-documents/authoritative-document.service";
import { runAuthoritativePdfArchiveWorkerOnce } from "../../src/shared/authoritative-documents/authoritative-document.worker";

const invoiceId = Number.parseInt(process.argv[2] ?? "", 10);
if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new Error("TEST invoice id required");

async function main() {
  try {
    const identity = await pool.query<{ database: string }>("SELECT current_database() AS database");
    if (!/^cerp_ec1454_(buyer|seller)_v2$/.test(identity.rows[0]?.database ?? "")) throw new Error("Unsafe invoice archive fixture database");
    const invoice = await pool.query<{ uuid: string; statut: string; legal_number: string | null; document_checksum_sha256: string | null }>(
      "SELECT uuid::text,statut,legal_number,lower(document_checksum_sha256) AS document_checksum_sha256 FROM public.facture WHERE id=$1", [invoiceId]);
    const row = invoice.rows[0];
    if (!row || row.statut !== "ISSUED" || !row.legal_number || !row.document_checksum_sha256) throw new Error("TEST invoice must be issued with immutable checksum");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const archive = await pool.query<{ id: string; archived_at: string | null; pdf_sha256: string | null; pdf_size_bytes: string | null; ged_document_id: string | null; ged_version_id: string | null }>(`
        SELECT archive.id::text,archive.archived_at::text,lower(archive.pdf_sha256) AS pdf_sha256,archive.pdf_size_bytes::text,archive.ged_document_id::text,archive.ged_version_id::text
        FROM public.authoritative_pdf_archives archive
        WHERE archive.entity_type='facture' AND archive.entity_id=$1::text AND archive.document_kind='FINANCE_INVOICE_LEGAL_PDF'
        ORDER BY archive.created_at DESC LIMIT 1`, [row.uuid]);
      const current = archive.rows[0];
      if (current?.archived_at && current.pdf_sha256 && current.pdf_size_bytes && current.ged_document_id && current.ged_version_id) {
        const pdf = await readOfficialPdfBytes({ entityType: "facture", entityId: row.uuid, documentKind: "FINANCE_INVOICE_LEGAL_PDF", archiveId: current.id, actorUserId: 1, eventType: "AUTHORITATIVE_PDF_DOWNLOADED" });
        if (pdf.sha256 !== current.pdf_sha256 || !pdf.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("TEST archived invoice PDF integrity mismatch");
        const root = process.env.CERP_E2E_RUN_ROOT ?? (process.env.CERP_GED_VAULT_ROOT ? path.dirname(process.env.CERP_GED_VAULT_ROOT) : undefined);
        if (!root) throw new Error("TEST private fixture root unavailable");
        const outputDirectory = path.join(root, "proofs"); const outputPath = path.join(outputDirectory, `invoice-${invoiceId}-${current.id}.pdf`);
        await mkdir(outputDirectory, { recursive: true }); await writeFile(outputPath, pdf.bytes, { flag: "w" });
        process.stdout.write(`E2E_INVOICE_ARCHIVE_PASS ${JSON.stringify({ invoice_id: invoiceId, legal_number: row.legal_number, archive_id: current.id, pdf_sha256: pdf.sha256, pdf_size_bytes: pdf.bytes.byteLength, exported_pdf: outputPath })}\n`);
        return;
      }
      await runAuthoritativePdfArchiveWorkerOnce(undefined, `fixture-invoice-pdf-worker:${process.pid}`);
    }
    throw new Error("TEST invoice archive worker did not finish");
  } finally { await pool.end(); }
}
main().catch((error) => { process.stderr.write(`E2E_INVOICE_ARCHIVE_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
