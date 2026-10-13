import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

type Db = Pick<PoolClient, "query">;
type Commitments = { started: boolean; stock: boolean; planning: boolean; grouped: boolean; children: boolean };

/** Caller holds the planning/OF locks and supplies the existing audited cancellation transaction. */
export async function releasePrelaunchPurchaseAllocationsTx(tx: Db, ofId: number) {
  const state = (await tx.query<Commitments>(`
    SELECT
      EXISTS(SELECT 1 FROM public.ordres_fabrication o WHERE o.id=$1 AND
        (o.date_lancement_reelle IS NOT NULL OR o.quantite_bonne>0 OR o.quantite_rebut>0))
      OR EXISTS(SELECT 1 FROM public.of_operations op WHERE op.of_id=$1 AND op.status::text NOT IN ('TODO','READY','BLOCKED'))
      OR EXISTS(SELECT 1 FROM public.of_time_logs log JOIN public.of_operations op ON op.id=log.of_operation_id WHERE op.of_id=$1)
      OR EXISTS(SELECT 1 FROM public.production_quantity_declarations d JOIN public.of_operations op ON op.id=d.operation_id WHERE op.of_id=$1)
      OR EXISTS(SELECT 1 FROM public.production_material_debits d WHERE d.of_id=$1) AS started,
      EXISTS(SELECT 1 FROM public.stock_reservations r WHERE
        (r.of_id=$1 OR (r.source_type='OF' AND r.source_id=$1::text)) AND
        ((r.status='ACTIVE' AND r.qty_reserved>r.qty_consumed) OR r.qty_consumed>0)) AS stock,
      EXISTS(SELECT 1 FROM public.planning_events e WHERE
        (e.of_id=$1 OR e.of_operation_id IN(SELECT id FROM public.of_operations WHERE of_id=$1))
        AND e.archived_at IS NULL AND e.status<>'CANCELLED') AS planning,
      EXISTS(SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id=$1 AND a.state='ACTIVE')
      OR EXISTS(SELECT 1 FROM public.production_consolidations c WHERE c.producer_of_id=$1) AS grouped,
      EXISTS(SELECT 1 FROM public.ordres_fabrication child WHERE child.parent_of_id=$1 AND child.statut::text<>'ANNULE') AS children
  `, [ofId])).rows[0];
  if (!state || [state.started, state.stock, state.planning, state.grouped, state.children].some(value => typeof value !== "boolean"))
    throw new HttpError(409, "OF_CANCELLATION_CHECK_UNAVAILABLE", "Les engagements de cet OF doivent être vérifiés avant son annulation.");
  const blockers = [state.started && "Fabrication ou pointage déjà enregistré", state.stock && "Réservation matière à libérer",
    state.planning && "Créneaux à retirer du planning", state.grouped && "Regroupement à traiter", state.children && "Sous-OF actifs à traiter"].filter(Boolean);
  if (blockers.length) throw new HttpError(409, "OF_CANCELLATION_COMMITMENTS", blockers.join(". ") + ".", { of_id: ofId, blockers });

  const allocations = (await tx.query<{ id: string; purchase_order_id: string; quantity: number }>(`
    SELECT b.id::text, l.commande_id::text AS purchase_order_id, b.quantite_couverte::float8 AS quantity
    FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id
    WHERE (b.besoin_of_id=$1 OR b.of_id=$1) AND NOT b.annule ORDER BY b.id FOR UPDATE OF b
  `, [ofId])).rows;
  if (allocations.length) {
    await tx.query(`UPDATE public.commande_fournisseur_ligne_besoin
      SET annule=true WHERE id=ANY($1::uuid[]) AND NOT annule`, [allocations.map(allocation => allocation.id)]);
  }
  // Prices, ordered/received quantities, offsets, receipts, lots and documents stay intact.
  return allocations;
}
