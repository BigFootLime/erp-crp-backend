/* TEST-only guard proof: a buyer dropship order never becomes a local industrial order. */
import pool from "../../src/config/database";
import {
  repoAnalyzeCommandeStock,
  repoDeleteCommande,
  repoDuplicateCommande,
  repoGenerateAffairesFromOrder,
  repoGetCommandeWorkflow,
  repoPreviewAffairesFromCommande,
  repoRunCommandeWorkflowAction,
  repoUpdateCommande,
} from "../../src/module/commande-client/repository/commande-client.repository";

const orderId = process.argv[2] ?? "1";
const audit = { user_id: 1, user_role: "Administrateur", ip: null, user_agent: null, device_type: null, os: null, browser: null, path: "/e2e/intercompany-commercial-only-1454", page_key: "e2e", client_session_id: null };

async function expect409(work: () => Promise<unknown>, expectedCode: string) {
  try { await work(); }
  catch (error) {
    if ((error as { status?: unknown }).status === 409 && (error as { code?: unknown }).code === expectedCode) return;
    throw error;
  }
  throw new Error(`Expected ${expectedCode}`);
}

async function industrialCounts() {
  const counts = await pool.query<{ checkpoints: string; affaires: string; reservations: string; ofs: string }>(`
    SELECT
      (SELECT count(*)::text FROM public.commande_client_workflow_checkpoint WHERE commande_id=$1::bigint) AS checkpoints,
      (SELECT count(*)::text FROM public.commande_to_affaire WHERE commande_id=$1::bigint) AS affaires,
      (SELECT count(*)::text FROM public.stock_reservations reservation JOIN public.commande_ligne line ON line.id=reservation.commande_ligne_id WHERE line.commande_id=$1::bigint) AS reservations,
      (SELECT count(*)::text FROM public.ordres_fabrication WHERE commande_id=$1::bigint) AS ofs`, [orderId]);
  return counts.rows[0];
}

async function main() {
  try {
    const database = (await pool.query<{ database: string }>("SELECT current_database() AS database")).rows[0]?.database ?? "";
    if (!/^cerp_ec1454_(buyer|seller)_v2$/.test(database)) throw new Error("Unsafe fixture database");
    if (database.endsWith("seller_v2")) {
      const workflow = await repoGetCommandeWorkflow(orderId, 1, "Administrateur");
      if (!workflow?.checkpoints.some((checkpoint) => checkpoint.checkpoint_code === "stock_check")) throw new Error("Industrial CRP workflow was not preserved");
      process.stdout.write(`E2E_COMMERCIAL_ONLY_INDUSTRIAL_PASS ${JSON.stringify({ order_id: orderId, checkpoints: workflow.checkpoints.length })}\n`);
      return;
    }

    const before = await industrialCounts();
    const workflow = await repoGetCommandeWorkflow(orderId, 1, "Administrateur");
    if (!workflow || workflow.checkpoints.length !== 0) throw new Error("Dropship GET workflow created or exposed industrial checkpoints");
    await expect409(() => repoRunCommandeWorkflowAction(orderId, { action: "check_stock" }, 1, "Administrateur"), "SUPPLIER_DROPSHIP_INDUSTRIAL_FLOW_FORBIDDEN");
    await expect409(() => repoAnalyzeCommandeStock(orderId, audit), "SUPPLIER_DROPSHIP_INDUSTRIAL_FLOW_FORBIDDEN");
    await expect409(() => repoPreviewAffairesFromCommande(orderId), "SUPPLIER_DROPSHIP_INDUSTRIAL_FLOW_FORBIDDEN");
    await expect409(() => repoGenerateAffairesFromOrder(orderId, {} as never, audit), "SUPPLIER_DROPSHIP_INDUSTRIAL_FLOW_FORBIDDEN");
    await expect409(() => repoDuplicateCommande(orderId), "SUPPLIER_DROPSHIP_DUPLICATION_UNSUPPORTED");
    await expect409(() => repoUpdateCommande(orderId, {} as never, [], 1), "SUPPLIER_DROPSHIP_REVISION_UNSUPPORTED");
    await expect409(() => repoDeleteCommande(orderId, { user_id: 1, user_role: "Administrateur" }), "SUPPLIER_DROPSHIP_CANCELLATION_UNSUPPORTED");
    const after = await industrialCounts();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Dropship industrial guard mutated state");
    process.stdout.write(`E2E_COMMERCIAL_ONLY_DROPSHIP_PASS ${JSON.stringify({ order_id: orderId, before, after })}\n`);
  } finally { await pool.end(); }
}
main().catch((error) => { process.stderr.write(`E2E_COMMERCIAL_ONLY_FAIL ${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
