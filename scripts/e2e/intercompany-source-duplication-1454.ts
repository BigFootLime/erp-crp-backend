/* Read-only proof that an already consumed external receipt line is not billable again. */
import pool from "../../src/config/database";
import { repoPreviewFacture } from "../../src/module/facturation/repository/facture-workflow.repository";
import { facturePreviewBodySchema } from "../../src/module/facturation/validators/workflow.validators";

const sourceId = process.argv[2];
if (!sourceId) throw new Error("usage: intercompany-source-duplication-1454.ts SHIPMENT_MESSAGE_UUID");
async function main() {
  try {
    const input = facturePreviewBodySchema.parse({ client_id: "901", currency: "EUR", global_discount_percent: "0", sources: [{ source_type: "EXTERNAL_FULFILMENT_RECEIPT_LINE", source_id: sourceId, source_line_id: `${sourceId}:1`, quantity: "1.000" }], due_dates: [{ due_date: "2026-12-31", label: "TEST" }], regulatory: { billing_frame_code: "B1", operation_category: "GOODS", transaction_scope: "B2C" } });
    const preview = await repoPreviewFacture(input);
    if (!preview.blockers.some((blocker) => blocker.code === "SOURCE_FULLY_INVOICED" || blocker.code === "SOURCE_QUANTITY_EXCEEDED")) throw new Error(`EXTERNAL_RECEIPT_DUPLICATION_NOT_BLOCKED:${preview.blockers.map((blocker) => blocker.code).join(",")}`);
    process.stdout.write(`EXTERNAL_RECEIPT_DUPLICATION_BLOCKED ${JSON.stringify({ source_id: sourceId, blockers: preview.blockers.map((blocker) => blocker.code) })}\n`);
  } finally { await pool.end(); }
}
main().catch((error) => { process.stderr.write(`EXTERNAL_RECEIPT_DUPLICATION_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
