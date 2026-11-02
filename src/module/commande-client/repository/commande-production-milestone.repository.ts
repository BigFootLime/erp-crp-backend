import type { PoolClient } from "pg";
import { repoApplyCommandeWorkflowMilestone } from "./commande-client.repository";

type Queryable = Pick<PoolClient, "query">;

export async function reconcileCommandeProductionMilestonesInTransaction(params: {
  client: Queryable;
  actorUserId: number | null;
  orderIds: readonly number[];
}): Promise<void> {
  for (const orderId of [...new Set(params.orderIds)].filter(Number.isSafeInteger)) {
    await params.client.query("SELECT id FROM public.commande_client WHERE id=$1::bigint FOR UPDATE", [orderId]);
    const facts = await params.client.query<{ total: string; started: string; completed: string }>(`
      SELECT count(*) FILTER (WHERE statut::text <> 'ANNULE')::text total,
        count(*) FILTER (WHERE statut::text IN ('EN_COURS','EN_PAUSE','TERMINE','CLOTURE'))::text started,
        count(*) FILTER (WHERE statut::text IN ('TERMINE','CLOTURE'))::text completed
      FROM public.ordres_fabrication WHERE commande_id=$1::bigint FOR SHARE`, [orderId]);
    const fact = facts.rows[0]; const total = Number(fact?.total ?? 0);
    if (!total) continue;
    if (Number(fact?.started ?? 0) === total) await repoApplyCommandeWorkflowMilestone({
      tx: params.client, commande_id: orderId, nouveau_statut: "EN_PRODUCTION", cause: "production_sync",
      commentaire: "Jalon reconcilié depuis les OF engagés.", user_id: params.actorUserId,
      completed_checkpoint_codes: ["production_launch"], active_checkpoint_code: "production_completion",
    });
    if (Number(fact?.completed ?? 0) === total) await repoApplyCommandeWorkflowMilestone({
      tx: params.client, commande_id: orderId, nouveau_statut: "PRODUCTION_TERMINEE", cause: "production_sync",
      commentaire: "Jalon reconcilié depuis les OF terminés.", user_id: params.actorUserId,
      completed_checkpoint_codes: ["production_completion"], active_checkpoint_code: "quality_control",
    });
  }
}
