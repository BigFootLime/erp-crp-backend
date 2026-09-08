import type {PoolClient} from "pg";
import {HttpError} from "../../../utils/httpError";
import type {AuditContext} from "./production.repository";
import {repoCreateStockReservation} from "../../stock/repository/stock-reservation.repository";
import {preparationAudit} from "./production-preparation.repository";
import {quantity} from "../domain/of-material";

/** The receipt owner calls this before locking stock. The planning lock serializes
 * coverage confirmation with a receipt; OF locks precede reservation/lot locks. */
export async function lockMaterialReceiptRecipientsTx(tx:PoolClient,lineId:string){
  const installed=(await tx.query("SELECT to_regclass('public.of_material_receipt_transfers') AS installed")).rows[0]?.installed;
  if(!installed)return false;
  await tx.query("SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE");
  await tx.query(`SELECT o.id FROM public.ordres_fabrication o WHERE o.id IN (
    SELECT b.besoin_of_id FROM public.commande_fournisseur_ligne_besoin b
    JOIN public.reception_fournisseur_lignes r ON r.commande_fournisseur_ligne_id=b.ligne_id
    WHERE r.id=$1::uuid AND NOT b.annule AND b.material_need_id IS NOT NULL
  ) ORDER BY o.id FOR UPDATE`,[lineId]);
  return true;
}

/** No new quantity register: every transfer links to one canonical reservation.
 * Quality liberation and the IN movement have already succeeded in this tx.
 * A later specification check can block execution, without losing the promise. */
export async function transferMaterialReceiptTx(tx:PoolClient,receiptId:string,audit:AuditContext){
  const receipt=(await tx.query(`SELECT s.id::text,ml.qty::float8,r.commande_fournisseur_ligne_id::text AS line_id,
    r.article_id::text,r.lot_id::text,ml.unite,m.status AS movement_status,ml.dst_magasin_id::text,ml.dst_emplacement_id
    FROM public.reception_fournisseur_stock_receipts s JOIN public.reception_fournisseur_lignes r ON r.id=s.reception_line_id
    JOIN public.stock_movements m ON m.id=s.stock_movement_id
    JOIN public.stock_movement_lines ml ON ml.movement_id=m.id AND ml.line_no=1 WHERE s.id=$1::uuid`,[receiptId])).rows[0];
  if(!receipt?.line_id)return [];
  if(receipt.movement_status!=="POSTED")throw new HttpError(409,"MATERIAL_RECEIPT_NOT_POSTED","La mise en stock doit être comptabilisée avant l’affectation.");
  const allocations=(await tx.query(`SELECT b.id::text,b.material_need_id::text,b.besoin_of_id AS of_id,
    (CASE WHEN b.besoin_type='OF_MATERIAL' THEN b.quantite_couverte ELSE b.quantite_couverte*COALESCE(l.coef_conversion,1) END)::float8 AS assigned,
    n.article_id::text,n.unit,n.operation_id::text,
    COALESCE((SELECT sum(sr.qty_reserved) FROM public.of_material_receipt_transfers t JOIN public.stock_reservations sr ON sr.id=t.reservation_id WHERE t.purchase_need_id=b.id),0)::float8 AS transferred
    FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id LEFT JOIN public.of_material_needs n ON n.id=b.material_need_id
    WHERE b.ligne_id=$1::uuid AND NOT b.annule ORDER BY b.created_at,b.id FOR UPDATE OF b`,[receipt.line_id])).rows;
  const posted=(await tx.query(`SELECT COALESCE(sum(ml.qty),0)::float8 AS qty FROM public.reception_fournisseur_stock_receipts s
    JOIN public.reception_fournisseur_lignes r ON r.id=s.reception_line_id JOIN public.stock_movements m ON m.id=s.stock_movement_id AND m.status='POSTED'
    JOIN public.stock_movement_lines ml ON ml.movement_id=m.id AND ml.line_no=1
    WHERE r.commande_fournisseur_ligne_id=$1::uuid`,[receipt.line_id])).rows[0].qty as number;
  const alreadyHere=(await tx.query(`SELECT COALESCE(sum(r.qty_reserved),0)::float8 AS qty FROM public.of_material_receipt_transfers t
    JOIN public.stock_reservations r ON r.id=t.reservation_id WHERE t.receipt_id=$1::uuid`,[receiptId])).rows[0].qty as number;
  let remaining=quantity(receipt.qty-alreadyHere),earlier=0;
  const transfers:Array<{ofId:number;reservationId:string;quantity:number}>=[];
  for(const allocation of allocations){
    const entitlement=Math.min(allocation.assigned,Math.max(0,posted-earlier));
    earlier=quantity(earlier+allocation.assigned);
    if(!allocation.material_need_id)continue;
    const qty=quantity(Math.min(remaining,Math.max(0,entitlement-allocation.transferred)));
    if(qty<=0)continue;
    if(allocation.article_id!==receipt.article_id||allocation.unit?.trim().toUpperCase()!==receipt.unite?.trim().toUpperCase())
      throw new HttpError(409,"MATERIAL_RECEIPT_UNIT_MISMATCH","L’article ou l’unité de réception diffère du besoin affecté. Corrigez la réception avant mise en stock.");
    const result=await repoCreateStockReservation({article_id:receipt.article_id,magasin_id:receipt.dst_magasin_id,emplacement_id:Number(receipt.dst_emplacement_id),
      lot_id:receipt.lot_id,qty,source:{source_type:"OF",of_id:Number(allocation.of_id)},reason:"Affectation de la réception au besoin matière déjà destinataire"},
      audit,`material-receipt:${receiptId}:${allocation.id}`,tx,allocation.material_need_id);
    await tx.query("INSERT INTO public.of_material_receipt_transfers(receipt_id,purchase_need_id,reservation_id) VALUES($1::uuid,$2::uuid,$3::uuid)",[receiptId,allocation.id,result.reservation.id]);
    await preparationAudit(tx,audit,Number(allocation.of_id),"production.of.material.receipt_transferred",{receiptId,purchaseNeedId:allocation.id,reservationId:result.reservation.id,quantity:qty});
    transfers.push({ofId:Number(allocation.of_id),reservationId:result.reservation.id,quantity:qty});
    remaining=quantity(remaining-qty);
  }
  return transfers;
}
