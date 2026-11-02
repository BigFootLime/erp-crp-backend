import type { PoolClient } from "pg";
import { repoApplyCommandeWorkflowMilestone } from "./commande-client.repository";
import { reconcileCommandeQualityMilestoneInTransaction } from "./commande-quality-milestone.repository";

type Queryable = Pick<PoolClient, "query">;

export async function reconcileCommandeProductionMilestonesInTransaction(params: {
  client: Queryable;
  actorUserId: number | null;
  orderIds: readonly number[];
}): Promise<void> {
  const ids = [...new Set(params.orderIds)].filter(Number.isSafeInteger).sort((a, b) => a - b);
  for (const orderId of ids) {
    await params.client.query("SELECT id FROM public.commande_client WHERE id=$1::bigint FOR UPDATE", [orderId]);
    const facts = await params.client.query<{ statut: string }>(`
      SELECT o.statut::text AS statut FROM public.ordres_fabrication o
      LEFT JOIN public.commande_ligne l ON l.id=o.commande_ligne_id
      WHERE (o.commande_id=$1::bigint OR l.commande_id=$1::bigint)
        AND o.statut::text <> 'ANNULE' ORDER BY o.id FOR SHARE`, [orderId]);
    const total = facts.rows.length;
    if (!total) continue;
    const started = facts.rows.every(({ statut }) => ["EN_COURS", "EN_PAUSE", "TERMINE", "CLOTURE"].includes(statut));
    const completed = facts.rows.every(({ statut }) => ["TERMINE", "CLOTURE"].includes(statut));
    const checkpoint = await params.client.query<{ checkpoint_code: string; status: string }>(
      `SELECT checkpoint_code,status FROM public.commande_client_workflow_checkpoint
       WHERE commande_id=$1 AND checkpoint_code IN ('production_launch','production_completion') FOR UPDATE`, [orderId]);
    const active = new Map(checkpoint.rows.map((row) => [row.checkpoint_code, row.status]));
    if (started && active.get("production_launch") === "active") await repoApplyCommandeWorkflowMilestone({
      tx: params.client, commande_id: orderId, nouveau_statut: "EN_PRODUCTION", cause: "production_sync",
      commentaire: "Jalon reconcilié depuis les OF engagés.", user_id: params.actorUserId,
      completed_checkpoint_codes: ["production_launch"], active_checkpoint_code: "production_completion",
    });
    if (completed && active.get("production_completion") === "active") await repoApplyCommandeWorkflowMilestone({
      tx: params.client, commande_id: orderId, nouveau_statut: "PRODUCTION_TERMINEE", cause: "production_sync",
      commentaire: "Jalon reconcilié depuis les OF terminés.", user_id: params.actorUserId,
      completed_checkpoint_codes: ["production_completion"], active_checkpoint_code: "quality_control",
    });
    if (completed) await reconcileCommandeQualityMilestoneInTransaction(params.client, orderId, params.actorUserId);
  }
}
