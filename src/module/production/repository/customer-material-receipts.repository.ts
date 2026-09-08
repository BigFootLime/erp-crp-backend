import type {PoolClient} from 'pg';
import type {AuditContext} from './production.repository';
import {HttpError} from '../../../utils/httpError';
import {repoCreateStockReservation} from '../../stock/repository/stock-reservation.repository';
import {preparationAudit} from './production-preparation.repository';

export async function transferCustomerMaterialReceiptTx(tx:PoolClient,receiptId:string,audit:AuditContext){
  const r=(await tx.query(`SELECT c.id::text AS call_id,c.client_id,n.id::text AS need_id,n.of_id,n.unit,n.article_id::text,n.superseded_at,
    EXISTS(SELECT 1 FROM public.of_material_revision_resolutions resolution WHERE resolution.previous_need_id=n.id AND resolution.disposition='KEEP_SEPARATE') AS kept_separate,
    m.status,ml.qty::float8,ml.unite,ml.article_id::text AS received_article,ml.dst_magasin_id::text,ml.dst_emplacement_id,l.lot_id::text,lot.client_proprietaire_id
    FROM public.reception_fournisseur_stock_receipts s JOIN public.reception_fournisseur_lignes l ON l.id=s.reception_line_id
    JOIN public.of_customer_material_calls c ON c.id=l.customer_material_call_id
    JOIN public.v_of_material_need_destinations destination ON destination.source_need_id=c.need_id
    JOIN public.of_material_needs n ON n.id=destination.target_need_id
    JOIN public.stock_movements m ON m.id=s.stock_movement_id JOIN public.stock_movement_lines ml ON ml.movement_id=m.id AND ml.line_no=1
    JOIN public.lots lot ON lot.id=l.lot_id WHERE s.id=$1::uuid`,[receiptId])).rows[0];
  if(!r)return [];
  if((await tx.query('SELECT 1 FROM public.of_customer_material_receipt_transfers WHERE receipt_id=$1::uuid',[receiptId])).rowCount)return [];
  if(r.status!=='POSTED'||(r.superseded_at&&!r.kept_separate)||r.client_id!==r.client_proprietaire_id||r.unit!==r.unite||r.article_id!==r.received_article)
    throw new HttpError(409,'CUSTOMER_MATERIAL_RECEIPT_MISMATCH','Vérifiez le besoin, le client propriétaire et l’unité avant affectation.');
  // An explicit separation preserves the receipt in client-owned free stock.
  // It must not reserve against either the superseded or the current need.
  if(r.kept_separate)return [];
  const result=await repoCreateStockReservation({article_id:r.article_id,magasin_id:r.dst_magasin_id,emplacement_id:Number(r.dst_emplacement_id),lot_id:r.lot_id,qty:r.qty,
    source:{source_type:'OF',of_id:Number(r.of_id)},reason:'Bruts client reçus et libérés, affectés à leur OF destinataire'},audit,`customer-material-receipt:${receiptId}`,tx,r.need_id);
  await tx.query('INSERT INTO public.of_customer_material_receipt_transfers(receipt_id,call_id,reservation_id) VALUES($1::uuid,$2::uuid,$3::uuid)',[receiptId,r.call_id,result.reservation.id]);
  await preparationAudit(tx,audit,Number(r.of_id),'production.of.material.customer_receipt_transferred',{receiptId,callId:r.call_id,reservationId:result.reservation.id,quantity:r.qty,clientId:r.client_id});
  return [{ofId:Number(r.of_id),reservationId:result.reservation.id,quantity:r.qty as number}];
}
