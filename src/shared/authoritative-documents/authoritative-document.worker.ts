import pool from "../../config/database";
import { renderSupplierPurchaseOrderOfficialPdf } from "../../module/commande-fournisseur/services/commande-fournisseur-official-pdf";
import { renderDevisOfficialPdf } from "../../module/devis/services/devis-official-pdf";
import { renderCommandeArOfficialPdf } from "../../module/commande-client/services/commande-ar.service";
import { renderInternalCreationSnapshotPdf } from "./internal-creation-snapshot-pdf";
import { repoClaimAuthoritativePdfWork } from "./authoritative-document.repository";
import { AuthoritativePdfProducerRegistry, runClaimedAuthoritativePdfArchive } from "./authoritative-document.service";

function parseInterval(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? "30000", 10);
  return Number.isSafeInteger(value) && value >= 5_000 && value <= 300_000 ? value : 30_000;
}

/** Explicit producer list prevents an arbitrary entity type from becoming renderable. */
export function createAuthoritativePdfProducerRegistry(): AuthoritativePdfProducerRegistry {
  const registry = new AuthoritativePdfProducerRegistry();
  registry.register("commande-fournisseur", "SUPPLIER_PURCHASE_ORDER", renderSupplierPurchaseOrderOfficialPdf);
  registry.register("devis", "CUSTOMER_QUOTE", renderDevisOfficialPdf);
  registry.register("commande-client", "CUSTOMER_ORDER_ACKNOWLEDGEMENT", renderCommandeArOfficialPdf);
  registry.register("client", "CLIENT_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  registry.register("fournisseur", "SUPPLIER_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  registry.register("commande-client", "CUSTOMER_ORDER_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  registry.register("ordre-fabrication", "OF_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  registry.register("piece-technique", "TECHNICAL_PIECE_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  registry.register("affaire", "AFFAIR_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  registry.register("stock-article", "STOCK_ARTICLE_CREATION_SNAPSHOT", renderInternalCreationSnapshotPdf);
  return registry;
}

export async function runAuthoritativePdfArchiveWorkerOnce(
  registry: AuthoritativePdfProducerRegistry = createAuthoritativePdfProducerRegistry(),
  workerId = `pdf-worker:${process.pid}`
): Promise<number> {
  const client = await pool.connect();
  let items;
  try {
    await client.query("BEGIN");
    items = await repoClaimAuthoritativePdfWork(client, workerId, 8);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* connection released below */ }
    throw error;
  } finally { client.release(); }
  let completed = 0;
  let failed = 0;
  let commitUncertain = 0;
  for (const item of items) {
    try {
      await runClaimedAuthoritativePdfArchive(item, registry);
      completed += 1;
    } catch (error) {
      // `GED_COMMIT_UNCERTAIN` intentionally remains leased for reconcile /
      // stale-lease recovery. Every other item must still get its own chance.
      if (error instanceof Error && (error as { code?: string }).code === "GED_COMMIT_UNCERTAIN") commitUncertain += 1;
      else failed += 1;
    }
  }
  if (failed || commitUncertain) {
    // Aggregate-only operational signal: no archive id, path, source snapshot,
    // or renderer exception is emitted to application logs.
    console.error(JSON.stringify({
      type: "authoritative_pdf_archive_worker_item_failures",
      claimed: items.length,
      completed,
      failed,
      commit_uncertain: commitUncertain,
    }));
  }
  return items.length;
}

/** Bounded serial worker; failures remain in the durable outbox for retry. */
export function startAuthoritativePdfArchiveMaintenance(): () => void {
  const registry = createAuthoritativePdfProducerRegistry();
  const workerId = `pdf-worker:${process.pid}`;
  let running = false;
  const cycle = async () => {
    if (running) return;
    running = true;
    try { await runAuthoritativePdfArchiveWorkerOnce(registry, workerId); }
    catch (error) {
      // Never expose DB paths or PDF source values in logs; durable outbox has
      // the per-item sanitized failure message for operators.
      console.error(JSON.stringify({ type: "authoritative_pdf_archive_worker_failed", code: (error as { code?: string } | null)?.code ?? "UNKNOWN" }));
    } finally { running = false; }
  };
  void cycle();
  const timer = setInterval(() => void cycle(), parseInterval(process.env.CERP_AUTHORITATIVE_PDF_ARCHIVE_INTERVAL_MS));
  timer.unref?.();
  return () => clearInterval(timer);
}
