import pool from "../../../config/database";
import type { PoolClient } from "pg";
import { repoClaimAuthoritativePdfWork } from "../../../shared/authoritative-documents/authoritative-document.repository";
import {
  AuthoritativePdfProducerRegistry,
  runClaimedAuthoritativePdfArchive,
} from "../../../shared/authoritative-documents/authoritative-document.service";
import { isTestEmailEnvironment } from "../../../shared/email/test-email-routing";
import { HttpError } from "../../../utils/httpError";
import { roleHasCommandeFournisseurCapability } from "../domain/commande-fournisseur-rbac";
import type { AuditContext } from "../repository/commande-fournisseur.repository";
import { renderSupplierPurchaseOrderOfficialPdf } from "./commande-fournisseur-official-pdf";

export function canResumeSupplierOrderTestPdf(env: NodeJS.ProcessEnv = process.env) {
  return env.CERP_COMPANY_ENVIRONMENT === "cerp_test" &&
    env.CERP_BACKGROUND_WORKERS === "off" && isTestEmailEnvironment(env);
}

let activeOrder: string | null = null;

export async function readCurrentSupplierTestArchive(
  tx: Pick<PoolClient, "query">, orderId: string, freezeId: string,
) {
  const archive = (await tx.query<{ id: string; frozen: string | null }>(
    `SELECT id::text, source_snapshot->'frozen_document'->>'id' AS frozen
     FROM public.authoritative_pdf_archives
     WHERE current_database()='cerp_test'
       AND entity_type='commande-fournisseur' AND entity_id=$1 AND document_kind='SUPPLIER_PURCHASE_ORDER'
     ORDER BY created_at DESC, document_version DESC, id DESC LIMIT 1`, [orderId],
  )).rows[0];
  return archive?.frozen === freezeId ? archive.id : null;
}

async function claimCurrentApprovedTestPdf(orderId: string) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SET LOCAL statement_timeout='3s'");
    await tx.query("SET LOCAL lock_timeout='1s'");
    const approved = (await tx.query<{ id: string; frozen: string }>(
      `SELECT cf.id::text, d.id::text AS frozen
       FROM public.commande_fournisseur cf
       JOIN public.commande_fournisseur_document d ON d.commande_id=cf.id AND d.version=cf.version_document
       WHERE current_database()='cerp_test' AND NOT pg_is_in_recovery()
         AND cf.id=$1::uuid AND cf.statut='APPROUVEE'
         AND NOT EXISTS (SELECT 1 FROM public.intercompany_purchase_order_links i WHERE i.buyer_purchase_order_id=cf.id)
       FOR UPDATE OF cf`, [orderId],
    )).rows[0];
    const archiveId = approved && await readCurrentSupplierTestArchive(tx, approved.id, approved.frozen);
    if (!archiveId) {
      throw new HttpError(409, "SUPPLIER_EMAIL_CURRENT_PDF_NOT_FOUND", "Le PDF de la version approuvée est introuvable. Rechargez le bon.");
    }
    const [job] = await repoClaimAuthoritativePdfWork(tx, `supplier-test-pdf:${process.pid}`, 1, archiveId);
    await tx.query("COMMIT");
    return job;
  } catch (error) {
    try { await tx.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  } finally {
    tx.release();
  }
}

export async function resumeSupplierOrderTestPdf(orderId: string, audit: AuditContext) {
  if (!roleHasCommandeFournisseurCapability(audit.role, "send"))
    throw new HttpError(403, "FORBIDDEN_TRANSITION", "Votre rôle ne permet pas la préparation de l’envoi de ce bon.");
  if (!canResumeSupplierOrderTestPdf())
    throw new HttpError(404, "SUPPLIER_EMAIL_PDF_RESUME_UNAVAILABLE", "La reprise du PDF de test est indisponible.");
  if (activeOrder === orderId) return { started: false };
  if (activeOrder !== null)
    throw new HttpError(409, "SUPPLIER_EMAIL_PDF_RESUME_BUSY", "Un PDF de test est déjà en cours de préparation. Réessayez dans un instant.");
  activeOrder = orderId;

  try {
    const job = await claimCurrentApprovedTestPdf(orderId);
    if (!job) {
      activeOrder = null;
      return { started: false };
    }
    const registry = new AuthoritativePdfProducerRegistry();
    registry.register("commande-fournisseur", "SUPPLIER_PURCHASE_ORDER", renderSupplierPurchaseOrderOfficialPdf);
    // The response waits only for the durable claim. The renderer owns its
    // lease independently of the browser and never invokes mail transport.
    void runClaimedAuthoritativePdfArchive(job, registry).catch(() => {
      console.error(JSON.stringify({ type: "supplier_test_pdf_resume_failed" }));
    }).finally(() => { activeOrder = null; });
    return { started: true };
  } catch (error) {
    activeOrder = null;
    throw error;
  }
}
