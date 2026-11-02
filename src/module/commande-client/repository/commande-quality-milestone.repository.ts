import type { PoolClient } from "pg";
import { enqueueAppNotificationCreated, enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { HttpError } from "../../../utils/httpError";
import { repoApplyCommandeWorkflowMilestone, repoEnsureCommandeWorkflowCheckpoints } from "./commande-client.repository";
import { assertCommandeQualityReleased } from "./commande-fulfillment-guards.repository";

type Db = Pick<PoolClient, "query">;

/** A quality decision may cover only one lot or one OF of a larger order. */
export async function reconcileCommandeQualityMilestoneInTransaction(client: Db, orderId: number, actorUserId: number | null) {
  await client.query("SELECT id FROM public.commande_client WHERE id = $1 FOR UPDATE", [orderId]);
  const history = await client.query<{ nouveau_statut: string }>(
    `SELECT nouveau_statut FROM public.commande_historique
     WHERE commande_id = $1 ORDER BY date_action DESC, id DESC LIMIT 1`, [orderId],
  );
  const status = history.rows[0]?.nouveau_statut;
  if (status !== "PRODUCTION_TERMINEE" && status !== "CONTROLE_QUALITE") return;

  await repoEnsureCommandeWorkflowCheckpoints(client, orderId, status);
  const checkpoint = await client.query<{ status: string }>(
    `SELECT status FROM public.commande_client_workflow_checkpoint
     WHERE commande_id = $1 AND checkpoint_code = 'quality_control' FOR UPDATE`, [orderId],
  );
  if (checkpoint.rows[0]?.status !== "active") return;

  try {
    await assertCommandeQualityReleased(client, orderId);
  } catch (err) {
    if (err instanceof HttpError && err.code === "QUALITY_RELEASE_REQUIRED") return;
    throw err;
  }
  const transition = await repoApplyCommandeWorkflowMilestone({
    tx: client, commande_id: orderId, user_id: actorUserId,
    nouveau_statut: "PRET_LIVRAISON", cause: "quality_sync",
    commentaire: "Libération qualité constatée pour tous les OF de la commande.",
    completed_checkpoint_codes: ["quality_control"], active_checkpoint_code: "delivery",
  });
  if (!transition.changed) return;
  for (const notification of transition.notifications) {
    await enqueueAppNotificationCreated(client, notification.user_id, notification, {
      deduplicationKey: `notification:${notification.id}`,
    });
  }
  await enqueueEntityChanged(client, {
    entityType: "COMMANDE_CLIENT", entityId: String(orderId), action: "status_changed",
    module: "commandes-clients", at: new Date().toISOString(),
    invalidateKeys: ["commandes:list", `commandes:detail:${orderId}`],
  }, { deduplicationKey: `commande:quality-sync:${orderId}:${transition.history_id}` });
}

type QualityEvidence = { of_id: number | null; source_type?: string | null; source_id?: string | null };

export async function reconcileOrdersForQualityEvidence(client: Db, evidence: QualityEvidence, actorUserId: number | null) {
  if (evidence.of_id == null && !["OF", "OF_OPERATION", "LOT"].includes(evidence.source_type ?? "")) return;
  const affected = await client.query<{ id: number }>(
    `WITH related_of AS (
       SELECT $1::bigint AS id WHERE $1::bigint IS NOT NULL
       UNION SELECT id FROM public.ordres_fabrication WHERE $2 = 'OF' AND id::text = $3
       UNION SELECT of_id FROM public.of_operations WHERE $2 = 'OF_OPERATION' AND id::text = $3
       UNION SELECT of_id FROM public.of_output_lots WHERE $2 = 'LOT' AND lot_id::text = $3
     )
     SELECT DISTINCT linked.id FROM related_of
     JOIN public.ordres_fabrication o ON o.id = related_of.id
     LEFT JOIN public.commande_ligne l ON l.id = o.commande_ligne_id
     CROSS JOIN LATERAL (VALUES (o.commande_id), (l.commande_id)) AS linked(id)
     WHERE linked.id IS NOT NULL ORDER BY linked.id`,
    [evidence.of_id, evidence.source_type ?? null, evidence.source_id ?? null],
  );
  for (const { id } of affected.rows) {
    await reconcileCommandeQualityMilestoneInTransaction(client, Number(id), actorUserId);
  }
}
