import {randomUUID} from 'node:crypto';
import {HttpError} from '../../../utils/httpError';
import type {AuditContext} from './production.repository';
import type {MaterialDebitCorrection} from '../validators/of-material.validators';
import {materialCommand,readMaterialTx} from './of-material.repository';
import {syncMaterialOfQuantitiesTx} from './operation-readiness.repository';
import {compensateMaterialMovementTx,restoreMaterialReservationTx} from '../../stock/repository/material-compensation.repository';

export async function correctMaterialDebit(ofId:number,body:MaterialDebitCorrection,audit:AuditContext){
  return materialCommand(ofId,'CORRECT_DEBIT',body,audit,async(tx,current)=>{
    const debit=(await tx.query<{id:string;declaration_id:string;operation_id:string;technical_version_id:string}>(`SELECT d.id::text,d.declaration_id::text,d.operation_id::text,d.technical_version_id::text
      FROM public.production_material_debits d JOIN public.of_operations o ON o.id=d.operation_id JOIN public.ordres_fabrication f ON f.id=d.of_id
      WHERE d.id=$1::uuid AND d.of_id=$2 AND d.compensates_id IS NULL AND o.status::text='RUNNING' AND f.statut::text IN('EN_COURS','EN_PAUSE')
        AND NOT EXISTS(SELECT 1 FROM public.production_material_debits c WHERE c.compensates_id=d.id)
        AND NOT EXISTS(SELECT 1 FROM public.production_quantity_declarations c WHERE c.compensates_id=d.declaration_id) FOR UPDATE OF o`,[body.debitId,ofId])).rows[0];
    if(!debit)throw new HttpError(409,'MATERIAL_DEBIT_NOT_CORRECTABLE','Ce débit est déjà corrigé ou son opération est clôturée. Faites rouvrir le dossier par le responsable avant correction.');
    const transferred=(await tx.query(`SELECT id FROM public.production_transfer_batches WHERE material_debit_id=$1::uuid AND released_quantity>0`,[debit.id])).rows;
    if(transferred.length)throw new HttpError(409,'MATERIAL_DEBIT_TRANSFER_ACTIVE','Retournez les bruts transférés à l’étape suivante avant de compenser ce débit.');
    const sources=(await tx.query<{reservation_id:string;need_id:string;stock_movement_id:string;lot_id:string;actual:number;planned:number}>(`SELECT s.reservation_id::text,s.need_id::text,s.stock_movement_id::text,r.lot_id::text,
      COALESCE(s.actual_qty,abs(m.qty))::float8 AS actual,COALESCE(s.planned_qty,abs(m.qty))::float8 AS planned
      FROM public.production_material_debit_sources s JOIN public.stock_movements m ON m.id=s.stock_movement_id
      JOIN public.stock_reservations r ON r.id=s.reservation_id WHERE s.debit_id=$1::uuid ORDER BY r.lot_id,r.id`,[debit.id])).rows;
    const remnants=(await tx.query<{stock_movement_id:string;lot_id:string}>(`SELECT stock_movement_id::text,lot_id::text FROM public.production_material_remnants WHERE debit_id=$1::uuid ORDER BY lot_id`,[debit.id])).rows;
    for(const lotId of [...new Set([...sources,...remnants].map(s=>s.lot_id))].sort())await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE',[lotId]);
    if((await readMaterialTx(tx,ofId)).version!==current.version)throw new HttpError(409,'MATERIAL_COVERAGE_CHANGED','Le stock a changé pendant la préparation. Actualisez avant de corriger.');
    for(const r of remnants)await compensateMaterialMovementTx(tx,{movementId:r.stock_movement_id,ofId,kind:'REMNANT',key:`${body.idempotencyKey}:remnant:${r.lot_id}`,reason:body.reason},audit);
    const inverses=[];
    for(const source of sources){
      const inverse=await compensateMaterialMovementTx(tx,{movementId:source.stock_movement_id,ofId,kind:'SOURCE',key:`${body.idempotencyKey}:source:${source.reservation_id}`,reason:body.reason},audit);
      if(Math.abs(inverse.quantity-source.actual)>.000001)throw new HttpError(409,'MATERIAL_DEBIT_PROOF_MISMATCH','La quantité du mouvement ne correspond plus à la preuve de débit.');
      await restoreMaterialReservationTx(tx,{reservationId:source.reservation_id,quantity:inverse.quantity,reason:body.reason},audit);
      inverses.push({...source,movementId:inverse.movementId});
    }
    const correctionId=randomUUID();
    const declaration=(await tx.query<{id:string}>(`INSERT INTO public.production_quantity_declarations(of_id,operation_id,qty_good,qty_scrap,qty_rework,qty_pending_control,
      unite,note,compensates_id,compensation_reason,idempotency_key,declared_by)
      SELECT of_id,operation_id,-qty_good,-qty_scrap,-qty_rework,-qty_pending_control,unite,$2,id,$2,$3,$4
      FROM public.production_quantity_declarations WHERE id=$1::uuid RETURNING id::text`,[debit.declaration_id,body.reason,body.idempotencyKey,audit.user_id])).rows[0];
    await tx.query(`INSERT INTO public.production_material_debits(id,of_id,operation_id,technical_version_id,declaration_id,command_key,source_version,note,compensates_id,created_by)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9::uuid,$10)`,[correctionId,ofId,debit.operation_id,debit.technical_version_id,declaration.id,body.idempotencyKey,current.version,body.reason,debit.id,audit.user_id]);
    for(const s of inverses)await tx.query(`INSERT INTO public.production_material_debit_sources(debit_id,need_id,reservation_id,stock_movement_id,planned_qty,actual_qty)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)`,[correctionId,s.need_id,s.reservation_id,s.movementId,-s.planned,-s.actual]);
    await syncMaterialOfQuantitiesTx(tx,ofId,audit.user_id);
    return {coverage:await readMaterialTx(tx,ofId),correctionId};
  });
}
