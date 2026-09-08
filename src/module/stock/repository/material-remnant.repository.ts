import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {generateTransactionalBusinessCode} from '../../../shared/codes/code-generator.service';
import {repoCreateMovement,repoPostMovement,repoCreateLotGenealogy,type AuditContext} from './stock.repository';

/** Stock owns lot identity, the inbound movement and genealogy. The new shape
 * requires a new quality decision; a parent's release is never copied. */
export async function createMaterialRemnantTx(tx:PoolClient,input:{ofId:number;reservationId:string;quantity:number;dimensions:Record<string,number>;note:string;key:string},audit:AuditContext){
  const source=(await tx.query(`SELECT l.id::text AS lot_id,l.article_id::text,l.supplier_lot_code,l.received_at,l.expiry_at,
    l.client_proprietaire_id,l.material_properties,e.magasin_id::text,e.id::int AS emplacement_id,a.unite
    FROM public.stock_reservations r JOIN public.lots l ON l.id=r.lot_id JOIN public.articles a ON a.id=l.article_id
    JOIN public.emplacements e ON e.location_id=r.location_id WHERE r.id=$1::uuid AND r.of_id=$2 FOR UPDATE OF l`,[input.reservationId,input.ofId])).rows[0];
  if(!source)throw new HttpError(409,'MATERIAL_REMNANT_SOURCE_CHANGED','Le lot source de la chute n’est plus disponible.');
  const originalDimensions=source.material_properties?.dimensions??{};
  if(Object.entries(input.dimensions).some(([key,value])=>!Number.isFinite(value)||value<=0||originalDimensions[key]!=null&&value>Number(originalDimensions[key])))
    throw new HttpError(422,'MATERIAL_REMNANT_DIMENSIONS_INVALID','La chute doit avoir des dimensions positives compatibles avec son lot source.');
  const code=await generateTransactionalBusinessCode(tx,{prefix:'LOT'});
  const properties={...source.material_properties,dimensions:input.dimensions,remnant_source_lot_id:source.lot_id};
  const lot=(await tx.query<{id:string}>(`INSERT INTO public.lots(article_id,lot_code,supplier_lot_code,received_at,manufactured_at,expiry_at,
    client_proprietaire_id,material_properties,lot_status,notes,created_by,updated_by)
    VALUES($1::uuid,$2,$3,$4,current_date,$5,$6,$7::jsonb,'EN_ATTENTE',$8,$9,$9) RETURNING id::text`,
    [source.article_id,code,source.supplier_lot_code,source.received_at,source.expiry_at,source.client_proprietaire_id,JSON.stringify(properties),input.note,audit.user_id])).rows[0];
  const movement=await repoCreateMovement({movement_type:'IN',source_document_type:'OF',source_document_id:String(input.ofId),reason_code:'CHUTE_MATIERE',
    notes:input.note,idempotency_key:`${input.key}:create`,lines:[{article_id:source.article_id,lot_id:lot.id,qty:input.quantity,unite:source.unite,
      dst_magasin_id:source.magasin_id,dst_emplacement_id:source.emplacement_id,note:input.note}]},audit,{client:tx,trusted_source_flow:true});
  const posted=await repoPostMovement(movement.movement.id,{},audit,`${input.key}:post`,tx);
  if(posted?.movement.status!=='POSTED')throw new HttpError(409,'MATERIAL_REMNANT_NOT_POSTED','La remise en stock de la chute a échoué. Le débit est annulé.');
  await repoCreateLotGenealogy({operation_type:'TRANSFORM',parents:[{lot_id:source.lot_id,qty:input.quantity}],children:[{lot_id:lot.id,qty:input.quantity}],
    unit_code:source.unite,stock_movement_id:movement.movement.id},audit,`${input.key}:genealogy`,tx);
  return {lotId:lot.id,lotCode:code,sourceLotId:source.lot_id,stockMovementId:movement.movement.id,quantity:input.quantity,unit:source.unite as string};
}
