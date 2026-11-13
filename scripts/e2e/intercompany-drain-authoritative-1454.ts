/* Drains the real seller PDF archive queue for the local EC-1454 v2 fixture. */
import pool from "../../src/config/database";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runAuthoritativePdfArchiveWorkerOnce } from "../../src/shared/authoritative-documents/authoritative-document.worker";
import { readOfficialPdfBytes } from "../../src/shared/authoritative-documents/authoritative-document.service";

const archiveId = process.argv[2]?.trim() ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(archiveId)) throw new Error("TEST archive UUID required");

async function main() {
  try {
    const identity = await pool.query<{ database: string }>("SELECT current_database() AS database");
    if (identity.rows[0]?.database !== "cerp_ec1454_seller_v2") throw new Error("Unsafe seller archive fixture database");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await pool.query<{ archived_at: string | null; pdf_sha256: string | null; pdf_size_bytes: string | null; ged_document_id: string | null; ged_version_id: string | null }>(
        "SELECT archived_at::text,pdf_sha256,pdf_size_bytes::text,ged_document_id::text,ged_version_id::text FROM authoritative_pdf_archives WHERE id=$1::uuid",
        [archiveId],
      );
      const row = state.rows[0];
      if (!row) throw new Error("TEST archive missing");
      if (row.archived_at && row.pdf_sha256 && row.pdf_size_bytes && row.ged_document_id && row.ged_version_id) {
        const delivery = await pool.query<{ id: string }>(
          "SELECT entity_id AS id FROM authoritative_pdf_archives WHERE id=$1::uuid AND entity_type='bon-livraison' AND document_kind='DELIVERY_NOTE_SHIPPED'",
          [archiveId],
        );
        const deliveryId = delivery.rows[0]?.id;
        if (!deliveryId) throw new Error("TEST shipped delivery archive scope invalid");
        const pdf = await readOfficialPdfBytes({ entityType: "bon-livraison", entityId: deliveryId, documentKind: "DELIVERY_NOTE_SHIPPED", archiveId, actorUserId: 1, eventType: "AUTHORITATIVE_PDF_DOWNLOADED" });
        // The reusable launcher intentionally keeps its run-root private; its
        // GED vault is an approved child of that root.
        const root = process.env.CERP_E2E_RUN_ROOT ?? (process.env.CERP_GED_VAULT_ROOT ? path.dirname(process.env.CERP_GED_VAULT_ROOT) : undefined);
        if (!root) throw new Error("TEST private fixture root unavailable");
        const outputDirectory = path.join(root, "proofs");
        const outputPath = path.join(outputDirectory, `shipped-bl-${archiveId}.pdf`);
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(outputPath, pdf.bytes, { flag: "w" });
        process.stdout.write(`E2E_ARCHIVE_PASS ${JSON.stringify({ archive_id: archiveId, ...row, verified_pdf_sha256: pdf.sha256, exported_pdf: outputPath })}\n`);
        return;
      }
      await runAuthoritativePdfArchiveWorkerOnce(undefined, `fixture-shipped-pdf-worker:${process.pid}`);
    }
    throw new Error("TEST archive worker did not finish the shipped BL PDF");
  } finally {
    await pool.end();
  }
}

main().catch(error => { process.stderr.write(`E2E_ARCHIVE_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
