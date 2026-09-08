import type {DossierDb} from './of-dossier.repository';

/** Read immutable proofs beside canonical stock and WIP balances. */
export async function readMaterialDebitsTx(tx:DossierDb,ofId:number){
  return (await tx.query(`SELECT d.id::text,d.operation_id::text AS "operationId",d.created_at AS "createdAt",d.note,
    d.compensates_id::text AS "compensatesId",c.id::text AS "correctedBy",q.qty_good::float8 AS good,q.qty_scrap::float8 AS scrap,
    COALESCE(u.username,u.id::text) AS actor,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('reservationId',s.reservation_id,'movementId',s.stock_movement_id,
      'lotId',r.lot_id,'lotCode',l.lot_code,'unit',n.unit,'planned',COALESCE(s.planned_qty,abs(m.qty)),
      'actual',COALESCE(s.actual_qty,abs(m.qty))) ORDER BY l.lot_code,s.reservation_id)
      FROM public.production_material_debit_sources s JOIN public.stock_movements m ON m.id=s.stock_movement_id
      JOIN public.stock_reservations r ON r.id=s.reservation_id JOIN public.of_material_needs n ON n.id=s.need_id
      JOIN public.lots l ON l.id=r.lot_id WHERE s.debit_id=d.id),'[]'::jsonb) AS sources,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('lotId',r.lot_id,'lotCode',l.lot_code,'quantity',r.quantity,'unit',r.unit,
      'dimensions',r.dimensions,'quality',l.lot_status,'movementId',r.stock_movement_id) ORDER BY r.created_at,r.id)
      FROM public.production_material_remnants r JOIN public.lots l ON l.id=r.lot_id WHERE r.debit_id=d.id),'[]'::jsonb) AS remnants,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'successorId',t.successor_operation_id,'quantity',t.quantity,
      'released',t.released_quantity,'version',t.version,'events',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'action',e.action,'quantity',e.quantity,'reason',e.reason,'at',e.created_at) ORDER BY e.created_at,e.id)
        FROM public.production_material_transfer_events e WHERE e.transfer_id=t.id),'[]'::jsonb)) ORDER BY t.created_at,t.id)
      FROM public.production_transfer_batches t WHERE t.material_debit_id=d.id),'[]'::jsonb) AS transfers
    FROM public.production_material_debits d JOIN public.production_quantity_declarations q ON q.id=d.declaration_id
    JOIN public.users u ON u.id=d.created_by LEFT JOIN public.production_material_debits c ON c.compensates_id=d.id
    WHERE d.of_id=$1 ORDER BY d.created_at DESC,d.id DESC`,[ofId])).rows;
}
