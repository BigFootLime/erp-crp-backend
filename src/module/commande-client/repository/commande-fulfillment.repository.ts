import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";
import { repoEnsureCommandeWorkflowStatus } from "./commande-client.repository";
import { loadCommandeFulfillmentState } from "./commande-fulfillment-guards.repository";

export {
  assertCommandeFullyInvoiced,
  assertCommandeFullyShipped,
  assertCommandeHasActiveOf,
  assertCommandeHasPreparedDelivery,
  assertCommandeProductionCompleted,
  assertCommandeProductionStarted,
  assertCommandeQualityReleased,
} from "./commande-fulfillment-guards.repository";

type Queryable = Pick<PoolClient, "query">;

export async function syncCommandeAfterShipment(
  tx: Queryable,
  commandeId: number,
  userId: number
): Promise<{ advanced: boolean; status: string | null }> {
  // Fulfillment callers lock their BL/facture first, then this command row.
  // Keeping that order identical across shipment and invoice paths prevents
  // deadlocks. The command lock serializes aggregate reads so two concurrent
  // partial documents cannot both miss the other's just-committed completion.
  const header = await tx.query<{ order_type: string | null }>(
    `SELECT order_type FROM public.commande_client WHERE id = $1 FOR UPDATE`,
    [commandeId]
  );
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.fully_shipped) return { advanced: false, status: null };

  const transition = await repoEnsureCommandeWorkflowStatus({
    tx,
    commande_id: commandeId,
    nouveau_statut: "LIVRE",
    cause: "shipment_sync",
    commentaire: "Statut synchronisé automatiquement après sortie de stock complète et expédition du BL",
    user_id: userId,
  });
  if (!transition.changed) return { advanced: false, status: transition.nouveau_statut };

  const current = header.rows[0] ?? null;
  if (!current) return { advanced: false, status: null };

  const internalOrder = String(current.order_type ?? "").toUpperCase() === "INTERNE";
  await tx.query(
    `
      UPDATE public.commande_client_workflow_checkpoint
      SET
        status = CASE
          WHEN checkpoint_code = 'delivery' THEN 'done'
          WHEN checkpoint_code = 'invoicing' THEN $2
          WHEN checkpoint_code = 'archive' AND $2 = 'skipped' THEN 'active'
          ELSE status
        END,
        completed_at = CASE
          WHEN checkpoint_code = 'delivery' THEN COALESCE(completed_at, now())
          WHEN checkpoint_code = 'invoicing' AND $2 = 'skipped' THEN COALESCE(completed_at, now())
          ELSE completed_at
        END,
        completed_by = CASE
          WHEN checkpoint_code = 'delivery' THEN COALESCE(completed_by, $3)
          WHEN checkpoint_code = 'invoicing' AND $2 = 'skipped' THEN COALESCE(completed_by, $3)
          ELSE completed_by
        END,
        metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
        updated_at = now()
      WHERE commande_id = $1
        AND checkpoint_code IN ('delivery', 'invoicing', 'archive')
    `,
    [
      commandeId,
      internalOrder ? "skipped" : "active",
      userId,
      JSON.stringify({ synchronized_from: "delivery_shipped" }),
    ]
  );
  return { advanced: transition.changed, status: transition.nouveau_statut };
}

export async function syncCommandeAfterInvoiceIssue(
  tx: Queryable,
  commandeId: number,
  userId: number
): Promise<{ advanced: boolean; status: string | null }> {
  const header = await tx.query<{ order_type: string | null }>(
    `SELECT order_type FROM public.commande_client WHERE id = $1 FOR UPDATE`,
    [commandeId]
  );
  if (String(header.rows[0]?.order_type ?? "").toUpperCase() === "INTERNE") {
    throw new HttpError(409, "INTERNAL_ORDER_NOT_BILLABLE", "Une commande interne ne peut pas être facturée.");
  }
  const state = await loadCommandeFulfillmentState(tx, commandeId);
  if (!state.fully_invoiced) return { advanced: false, status: null };

  const transition = await repoEnsureCommandeWorkflowStatus({
    tx,
    commande_id: commandeId,
    nouveau_statut: "FACTURE",
    cause: "invoice_sync",
    commentaire: "Statut synchronisé automatiquement après émission complète de la facture",
    user_id: userId,
  });
  if (!transition.changed) return { advanced: false, status: transition.nouveau_statut };
  await tx.query(
    `
      UPDATE public.commande_client_workflow_checkpoint
      SET
        status = CASE
          WHEN checkpoint_code = 'invoicing' THEN 'done'
          WHEN checkpoint_code = 'archive' THEN 'active'
          ELSE status
        END,
        completed_at = CASE
          WHEN checkpoint_code = 'invoicing' THEN COALESCE(completed_at, now())
          WHEN checkpoint_code = 'archive' THEN NULL
          ELSE completed_at
        END,
        completed_by = CASE
          WHEN checkpoint_code = 'invoicing' THEN COALESCE(completed_by, $2)
          WHEN checkpoint_code = 'archive' THEN NULL
          ELSE completed_by
        END,
        metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
        updated_at = now()
      WHERE commande_id = $1
        AND checkpoint_code IN ('invoicing', 'archive')
    `,
    [commandeId, userId, JSON.stringify({ synchronized_from: "invoice_issued" })]
  );
  return { advanced: transition.changed, status: transition.nouveau_statut };
}

export async function listIssuedInvoiceCommandeIds(
  tx: Queryable,
  factureId: number
): Promise<number[]> {
  const result = await tx.query<{ commande_id: number }>(
    `
      SELECT DISTINCT delivery.commande_id::int AS commande_id
      FROM public.facture_source_allocations source
      JOIN public.bon_livraison_ligne delivery_line
        ON source.source_type = 'DELIVERY_LINE'
       AND source.source_line_id = delivery_line.id::text
      JOIN public.bon_livraison delivery
        ON delivery.id = delivery_line.bon_livraison_id
      JOIN public.commande_client commande
        ON commande.id = delivery.commande_id
      WHERE source.facture_id = $1
        AND source.allocation_status = 'CONSUMED'
        AND delivery.commande_id IS NOT NULL
        AND upper(COALESCE(commande.order_type, '')) <> 'INTERNE'
      ORDER BY delivery.commande_id
    `,
    [factureId]
  );
  return result.rows.map((row) => Number(row.commande_id)).filter(Number.isInteger);
}
