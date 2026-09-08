import {randomUUID} from 'node:crypto';
import {HttpError} from '../../../utils/httpError';
import type {AuditContext} from './production.repository';
import type {MaterialDebit} from '../validators/of-material.validators';
import {materialCommand,readMaterialTx} from './of-material.repository';
import {readOperationReadinessTx} from './operation-readiness.repository';
import {lotCompatibility} from '../domain/of-material';
import {actualDebitBalance} from '../domain/material-debit-balance';
import {createMaterialRemnantTx} from '../../stock/repository/material-remnant.repository';
import {consumeMaterialReservationTx} from '../../stock/repository/partial-reservation-consumption.repository';
import {assertOperationalLotQualityEligibility} from '../../qualite/repository/quality-operational-gate.repository';
import {repoDeclareQuantity} from './production-execution.repository';
import {releaseMaterialTransferTx} from './material-transfer.repository';

/** One owner for reservation consumption, stock posting, produced WIP and its
 * transfer proof. A failed declaration or transfer rolls back the whole debit. */
export async function debitOfMaterial(ofId:number,body:MaterialDebit,audit:AuditContext){
  return materialCommand(ofId,'DEBIT',body,audit,async(tx,current)=>{
    const needs=current.needs.filter(n=>n.operationId===body.operationId);
    if(!current.technicalVersion||!needs.length||needs.some(n=>!n.id||!n.debitRule||n.blockers.length))
      throw new HttpError(409,'MATERIAL_DEBIT_PREPARATION_REQUIRED','Complétez les matières et les règles de débit de cette opération.');
    const sources=body.sources.map(source=>{
      const need=needs.find(n=>n.reservations.some(r=>r.id===source.reservationId));
      const reservation=need?.reservations.find(r=>r.id===source.reservationId);
      const candidate=need?.candidates.find(c=>c.lot.batchId===reservation?.stock_batch_id);
      if(!need||!reservation||!candidate)throw new HttpError(409,'MATERIAL_DEBIT_SOURCE_CHANGED','Une réservation ne couvre plus cette opération. Actualisez la matière.');
      return {source,need,reservation,candidate};
    });
    for(const lotId of [...new Set(sources.map(s=>s.candidate.lot.id))].sort())
      await assertOperationalLotQualityEligibility({client:tx,lotId,qty:0,purpose:'RESERVE'});
    if((await readMaterialTx(tx,ofId)).version!==current.version)
      throw new HttpError(409,'MATERIAL_COVERAGE_CHANGED','Un lot a changé pendant la préparation. Actualisez le débit.');
    for(const s of sources){
      await assertOperationalLotQualityEligibility({client:tx,lotId:s.candidate.lot.id,qty:0,unit:s.need.unit,purpose:'RESERVE'});
      // The canonical gate above has already checked this lot under its lock.
      const reasons=lotCompatibility(s.need,{...s.candidate.lot,qualityBlocks:[]});
      if(reasons.length)throw new HttpError(409,'MATERIAL_DEBIT_LOT_INCOMPATIBLE',reasons.join(' '));
    }
    const readiness=await readOperationReadinessTx(tx,ofId);
    const operation=readiness.operations.find(op=>op.id===body.operationId);
    if(!operation||operation.status!=='RUNNING'||!operation.canStart)
      throw new HttpError(409,'MATERIAL_DEBIT_OPERATION_NOT_STARTED','Démarrez cette opération et vérifiez ses prérequis avant de débiter.',{operation});
    const measured=needs.some(n=>n.debitRule?.form!=='UNIT');
    if(body.good+body.scrap>(measured?operation.remainingQuantity:operation.availableQuantity))
      throw new HttpError(409,'MATERIAL_DEBIT_QUANTITY_EXCEEDED','Les bruts déclarés dépassent la quantité utilisable.',{available:operation.availableQuantity});
    const remnants=body.remnants??[];
    const balances=needs.map(need=>({need,balance:actualDebitBalance({rule:need.debitRule!,blanks:body.good+body.scrap,varianceReason:body.varianceReason,
      sources:sources.filter(s=>s.need.id===need.id).map(s=>({id:s.source.reservationId,quantity:s.source.quantity,remnant:remnants.find(r=>r.reservationId===s.source.reservationId)?.quantity??0}))})}));
    for(const remnant of remnants){
      const need=sources.find(s=>s.source.reservationId===remnant.reservationId)?.need;
      if(!need||!remnant.dimensions.longueur_mm||need.debitRule?.form==='SHEET'&&!remnant.dimensions.largeur_mm)
        throw new HttpError(422,'MATERIAL_REMNANT_DIMENSIONS_REQUIRED','Précisez la longueur de chaque chute et la largeur des chutes de tôle.');
    }
    const consumed=[];
    for(const s of [...sources].sort((a,b)=>a.source.reservationId.localeCompare(b.source.reservationId)))
      consumed.push({needId:s.need.id!,...await consumeMaterialReservationTx(tx,{...s.source,ofId,operationId:body.operationId,
        idempotencyKey:`${body.idempotencyKey}:${s.source.reservationId}`,reason:body.note},audit)});
    const debitId=randomUUID(),declarationId=randomUUID();
    // The deferred declaration FK allows the measured yield proof to exist
    // before the canonical declaration rechecks its material quantity credit.
    await tx.query(`INSERT INTO public.production_material_debits(id,of_id,operation_id,technical_version_id,declaration_id,command_key,source_version,note,created_by)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9)`,[debitId,ofId,body.operationId,current.technicalVersion,declarationId,body.idempotencyKey,current.version,[body.note,body.varianceReason].filter(Boolean).join('\n'),audit.user_id]);
    for(const s of consumed)await tx.query(`INSERT INTO public.production_material_debit_sources(debit_id,need_id,reservation_id,stock_movement_id,planned_qty,actual_qty)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6)`,[debitId,s.needId,s.reservationId,s.stockMovementId,
      balances.find(b=>b.need.id===s.needId)!.balance.sources.find(source=>source.id===s.reservationId)!.planned,s.quantity]);
    const declaration=await repoDeclareQuantity({transactionClient:tx,declarationId,idempotencyKey:body.idempotencyKey,audit,
      body:{of_id:ofId,operation_id:body.operationId,qty_good:body.good,qty_scrap:body.scrap,qty_pending_control:0,qty_rework:0,
        scrap_reason_code:body.scrapReason,unite:'u',note:body.note}});
    const createdRemnants=[];
    for(const remnant of remnants){
      const result=await createMaterialRemnantTx(tx,{...remnant,ofId,note:[body.note,body.varianceReason].filter(Boolean).join('\n'),key:`${body.idempotencyKey}:remnant:${remnant.reservationId}`},audit);
      await tx.query(`INSERT INTO public.production_material_remnants(debit_id,source_reservation_id,lot_id,stock_movement_id,quantity,unit,dimensions,created_by)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8)`,[debitId,remnant.reservationId,result.lotId,result.stockMovementId,result.quantity,result.unit,JSON.stringify(remnant.dimensions),audit.user_id]);
      createdRemnants.push(result);
    }
    if(body.successorOperationId){
      await releaseMaterialTransferTx(tx,{ofId,debitId,operationId:body.operationId,successorOperationId:body.successorOperationId,
        quantity:body.good,key:body.idempotencyKey,reason:body.note},audit);
    }
    return {coverage:await readMaterialTx(tx,ofId),debitId,declarationId:declaration.id,consumed,remnants:createdRemnants};
  });
}
