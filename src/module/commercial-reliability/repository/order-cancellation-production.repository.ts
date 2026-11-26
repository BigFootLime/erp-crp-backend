import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { repoArchivePlanningEvent, type AuditContext } from "../../planning/repository/planning.repository";
import { isOfPrelaunch, type OfStatut } from "../../production/domain/of-status";
import { assertOfPrelaunchCancellationTx, releaseOfPurchaseAllocationsTx } from "../../production/repository/of-prelaunch-cancellation.repository";
import { repoReleaseUnconsumedStockReservationTx } from "../../stock/repository/stock-reservation.repository";

/** The caller holds the central revision and order locks, in that order. */
export async function cancelOrderProductionTx(tx: PoolClient, orderId: number, afterAr: boolean, audit: AuditContext) {
  const { rows: orders } = await tx.query<{ id: string; status: OfStatut; foreign_line: boolean }>(`
    WITH RECURSIVE scoped_of(id) AS (
      SELECT o.id FROM public.ordres_fabrication o
      LEFT JOIN public.commande_ligne l ON l.id=o.commande_ligne_id
      WHERE o.commande_id=$1 OR (o.commande_id IS NULL AND l.commande_id=$1)
      UNION
      SELECT child.id FROM public.ordres_fabrication child JOIN scoped_of parent ON child.parent_of_id=parent.id
      WHERE (child.commande_id IS NULL OR child.commande_id=$1)
        AND NOT EXISTS (SELECT 1 FROM public.commande_ligne l WHERE l.id=child.commande_ligne_id AND l.commande_id<>$1)
    )
    SELECT o.id::text, o.statut::text AS status,
      EXISTS(SELECT 1 FROM public.commande_ligne l WHERE l.id=o.commande_ligne_id AND l.commande_id<>$1) AS foreign_line
    FROM public.ordres_fabrication o JOIN scoped_of s ON s.id=o.id
    WHERE o.statut<>'ANNULE' ORDER BY o.id FOR UPDATE OF o
  `, [orderId]);
  const ofIds = orders.map(row => Number(row.id));
  if (orders.some(row => row.foreign_line)) {
    throw new HttpError(409, "ORDER_PRODUCTION_LINK_CONFLICT", "Les rattachements commande des OF sont incohérents. Vérifiez-les avant l’annulation.");
  }
  if (orders.some(row => !isOfPrelaunch(row.status))) {
    throw new HttpError(409, "ORDER_PRODUCTION_STARTED", "Un OF a déjà été lancé. Annulation de la commande refusée.");
  }

  const { rows: events } = await tx.query<{ id: string; status: string; shared: boolean }>(`
    SELECT e.id::text,e.status::text,
      (e.of_id IS NOT NULL AND NOT(e.of_id=ANY($1::bigint[])))
      OR (op.of_id IS NOT NULL AND NOT(op.of_id=ANY($1::bigint[]))) AS shared
    FROM public.planning_events e LEFT JOIN public.of_operations op ON op.id=e.of_operation_id
    WHERE (e.of_id=ANY($1::bigint[]) OR op.of_id=ANY($1::bigint[]))
      AND e.archived_at IS NULL AND e.status<>'CANCELLED'
    ORDER BY e.id FOR UPDATE OF e
  `, [ofIds]);
  if (events.some(event => event.shared || !["PLANNED", "BLOCKED"].includes(event.status))) {
    throw new HttpError(409, "ORDER_PLANNING_COMMITMENT", "Un créneau est partagé ou a déjà démarré. Annulation refusée.");
  }
  const { rows: tasks } = await tx.query<{ id: string; committed: boolean }>(`
    SELECT t.id,t.committed_start IS NOT NULL AS committed FROM public.planning_tasks t
    WHERE (t.draft_of_id=ANY($1::bigint[]) OR EXISTS (
      SELECT 1 FROM public.of_operations op WHERE op.id=t.operation_id AND op.of_id=ANY($1::bigint[])))
      AND (t.committed_start IS NOT NULL OR t.forecast_start IS NOT NULL)
    ORDER BY t.id FOR UPDATE OF t
  `, [ofIds]);
  if (afterAr && (events.length || tasks.some(task => task.committed))) {
    throw new HttpError(409, "PLANNING_LOCKED_AFTER_AR", "Retirez les engagements de planning dans le parcours prévu avant d’annuler cette commande.");
  }

  await tx.query("SELECT id FROM public.of_operations WHERE of_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE", [ofIds]);
  for (const ofId of ofIds) await assertOfPrelaunchCancellationTx(tx, ofId, ofIds);
  const allocationsShared = (await tx.query<{ shared: boolean }>(`
    SELECT EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne_besoin b WHERE NOT b.annule
      AND b.of_id IS NOT NULL AND b.besoin_of_id IS NOT NULL
      AND (b.of_id=ANY($1::bigint[]))<>(b.besoin_of_id=ANY($1::bigint[]))) AS shared
  `, [ofIds])).rows[0]?.shared;
  if (allocationsShared) {
    throw new HttpError(409, "ORDER_PURCHASE_ALLOCATION_SHARED", "Une affectation d’achat appartient aussi à un autre OF. Annulation refusée.");
  }

  const { rows: reservations } = await tx.query<{ id: string; version: number; consumed: boolean; shared: boolean }>(`
    SELECT r.id::text,r.row_version::int AS version,r.qty_consumed>0 AS consumed,
      (r.of_id IS NOT NULL AND NOT (r.of_id=ANY($2::bigint[])))
      OR (r.source_type='OF' AND r.source_id IS NOT NULL AND NOT (r.source_id=ANY($3::text[])))
      OR (r.source_type='COMMANDE_LIGNE' AND EXISTS (SELECT 1 FROM public.commande_ligne l
        WHERE l.id::text=r.source_id AND l.commande_id<>$1)) AS shared
    FROM public.stock_reservations r
    WHERE (r.of_id=ANY($2::bigint[]) OR (r.source_type='OF' AND r.source_id=ANY($3::text[]))
      OR (r.source_type='COMMANDE_LIGNE' AND EXISTS (
        SELECT 1 FROM public.commande_ligne l WHERE l.commande_id=$1 AND l.id::text=r.source_id)))
      AND (r.status='ACTIVE' OR r.qty_consumed>0)
    ORDER BY r.lot_id NULLS LAST,r.id
  `, [orderId, ofIds, ofIds.map(String)]);
  if (reservations.some(row => row.shared || row.consumed)) {
    throw new HttpError(409, "ORDER_STOCK_COMMITMENT", "Du stock a déjà été consommé ou une réservation est liée à un autre OF. Annulation refusée.");
  }
  for (const reservation of reservations) {
    const key = createHash("sha256").update(`order-cancel:${orderId}:${reservation.id}`).digest("hex");
    const released = await repoReleaseUnconsumedStockReservationTx(tx, reservation.id, {
      expected_version: reservation.version, reason: "Annulation de la commande client",
    }, audit, key);
    if (!released) throw new HttpError(409, "ORDER_RESERVATION_CHANGED", "Une réservation a changé. Rechargez la commande et réessayez.");
  }

  for (const event of events) await repoArchivePlanningEvent({ id: event.id, audit, tx });
  const allocations = [];
  for (const ofId of ofIds) allocations.push(...await releaseOfPurchaseAllocationsTx(tx, ofId));

  if (tasks.length) {
    await tx.query(`UPDATE public.planning_tasks SET committed_start=NULL, committed_end=NULL,
      forecast_start=NULL, forecast_end=NULL, forecast_resource_ids=NULL, version=version+1, updated_at=clock_timestamp()
      WHERE id=ANY($1::text[])`, [tasks.map(task => task.id)]);
  }
  if (ofIds.length) {
    await tx.query(`UPDATE public.ordres_fabrication SET statut='ANNULE',date_lancement_prevue=NULL,
      date_fin_prevue=NULL,updated_by=$2,updated_at=now() WHERE id=ANY($1::bigint[])`, [ofIds, audit.user_id]);
  }
  return { ofIds, eventIds: events.map(event => event.id), reservationIds: reservations.map(reservation => reservation.id), allocations };
}
