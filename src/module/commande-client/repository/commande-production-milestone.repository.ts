import type { PoolClient } from "pg";
import { repoApplyCommandeWorkflowMilestone, repoEnsureCommandeWorkflowCheckpoints } from "./commande-client.repository";
import { reconcileCommandeQualityMilestoneInTransaction } from "./commande-quality-milestone.repository";

type Db = Pick<PoolClient, "query">;

export async function reconcileCommandeForOf(client: Db, ofId: number, actorUserId: number | null) {
  const linked = await client.query<{ id: number }>(
    `SELECT DISTINCT link.id FROM public.ordres_fabrication o
     LEFT JOIN public.commande_ligne l ON l.id = o.commande_ligne_id
     CROSS JOIN LATERAL (VALUES (o.commande_id), (l.commande_id)) link(id)
     WHERE o.id = $1 AND link.id IS NOT NULL ORDER BY link.id`, [ofId],
  );
  await reconcileCommandeProductionMilestonesInTransaction({
    client, actorUserId, orderIds: linked.rows.map(row => Number(row.id)),
  });
}

export async function reconcileCommandeProductionMilestonesInTransaction(params: {
  client: Db; actorUserId: number | null; orderIds: readonly number[];
}): Promise<void> {
  const { client, actorUserId } = params;
  for (const orderId of [...new Set(params.orderIds)].sort((a, b) => a - b)) {
    // Each OF transaction owns its own row. Serialise on the parent and read
    // siblings in a fresh statement, without locking a sibling OF in reverse order.
    const header = await client.query<{ order_type: string }>(
      "SELECT order_type FROM public.commande_client WHERE id = $1 FOR UPDATE", [orderId],
    );
    const history = await client.query<{ nouveau_statut: string }>(
      `SELECT nouveau_statut FROM public.commande_historique WHERE commande_id = $1
       ORDER BY date_action DESC, id DESC LIMIT 1`, [orderId],
    );
    const current = history.rows[0]?.nouveau_statut;
    if (current === "PRODUCTION_TERMINEE" || current === "CONTROLE_QUALITE") {
      await reconcileCommandeQualityMilestoneInTransaction(client, orderId, actorUserId);
      continue;
    }
    const internalLaunch = current === "PLANNING_VALIDE" && header.rows[0]?.order_type === "INTERNE";
    if (current !== "AR_ENVOYE" && current !== "EN_PRODUCTION" && !internalLaunch) continue;

    const ofs = await client.query<{ statut: string }>(
      `SELECT o.statut::text AS statut FROM public.ordres_fabrication o
       LEFT JOIN public.commande_ligne l ON l.id = o.commande_ligne_id
       WHERE (o.commande_id = $1 OR l.commande_id = $1) AND o.statut::text <> 'ANNULE'`, [orderId],
    );
    if (!ofs.rows.length) continue;
    const started = ofs.rows.every(({ statut }) => ["EN_COURS", "EN_PAUSE", "TERMINE", "CLOTURE"].includes(statut));
    if (!started) continue;
    await repoEnsureCommandeWorkflowCheckpoints(client, orderId, current);
    const checkpoints = await client.query<{ checkpoint_code: string; status: string }>(
      `SELECT checkpoint_code, status FROM public.commande_client_workflow_checkpoint
       WHERE commande_id = $1 AND checkpoint_code IN ('production_launch', 'production_completion') FOR UPDATE`, [orderId],
    );
    const stages = new Map(checkpoints.rows.map(row => [row.checkpoint_code, row.status]));
    let mayComplete = current === "EN_PRODUCTION" && stages.get("production_completion") === "active";
    if (current !== "EN_PRODUCTION" && stages.get("production_launch") === "active") {
      if (stages.get("production_completion") === "blocked") continue;
      await repoApplyCommandeWorkflowMilestone({
        tx: client, commande_id: orderId, nouveau_statut: "EN_PRODUCTION",
        cause: internalLaunch ? "internal_production_launch" : "production_sync",
        commentaire: "Tous les OF actifs ont démarré.", user_id: actorUserId,
        completed_checkpoint_codes: ["production_launch"], active_checkpoint_code: "production_completion",
      });
      mayComplete = true;
    }
    if (!mayComplete || !ofs.rows.every(({ statut }) => statut === "TERMINE" || statut === "CLOTURE")) continue;
    await repoApplyCommandeWorkflowMilestone({
      tx: client, commande_id: orderId, nouveau_statut: "PRODUCTION_TERMINEE", cause: "production_sync",
      commentaire: "Tous les OF actifs sont terminés ou clôturés.", user_id: actorUserId,
      completed_checkpoint_codes: ["production_completion"], active_checkpoint_code: "quality_control",
    });
    await reconcileCommandeQualityMilestoneInTransaction(client, orderId, actorUserId);
  }
}
