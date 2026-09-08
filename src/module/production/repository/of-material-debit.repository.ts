import {randomUUID} from 'node:crypto';
import {HttpError} from '../../../utils/httpError';
import type {AuditContext} from './production.repository';
import type {MaterialDebit} from '../validators/of-material.validators';
import {materialCommand,readMaterialTx} from './of-material.repository';
import {readOperationReadinessTx} from './operation-readiness.repository';
import {debitQuantity,lotCompatibility,quantity} from '../domain/of-material';
import {consumeMaterialReservationTx} from '../../stock/repository/partial-reservation-consumption.repository';
import {assertOperationalLotQualityEligibility} from '../../qualite/repository/quality-operational-gate.repository';
import {repoDeclareQuantity} from './production-execution.repository';

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
    if(body.good+body.scrap>operation.availableQuantity)
      throw new HttpError(409,'MATERIAL_DEBIT_QUANTITY_EXCEEDED','Les bruts déclarés dépassent la quantité utilisable.',{available:operation.availableQuantity});
    for(const need of needs){
      const actual=quantity(sources.filter(s=>s.need.id===need.id).reduce((sum,s)=>sum+s.source.quantity,0));
      const required=debitQuantity(need.debitRule!,body.good+body.scrap);
      if(actual!==required)throw new HttpError(422,'MATERIAL_DEBIT_CONVERSION_MISMATCH',`${need.designation} : la règle validée exige ${required} ${need.unit} pour ces bruts.`,{needKey:need.key,required,actual});
    }
    const consumed=[];
    for(const s of [...sources].sort((a,b)=>a.source.reservationId.localeCompare(b.source.reservationId)))
      consumed.push({needId:s.need.id!,...await consumeMaterialReservationTx(tx,{...s.source,ofId,operationId:body.operationId,
        idempotencyKey:`${body.idempotencyKey}:${s.source.reservationId}`,reason:body.note},audit)});
    const declaration=await repoDeclareQuantity({transactionClient:tx,idempotencyKey:body.idempotencyKey,audit,
      body:{of_id:ofId,operation_id:body.operationId,qty_good:body.good,qty_scrap:body.scrap,qty_pending_control:0,qty_rework:0,
        scrap_reason_code:body.scrapReason,unite:'u',note:body.note}});
    const debitId=randomUUID();
    await tx.query(`INSERT INTO public.production_material_debits(id,of_id,operation_id,technical_version_id,declaration_id,command_key,source_version,note,created_by)
      VALUES($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7,$8,$9)`,[debitId,ofId,body.operationId,current.technicalVersion,declaration.id,body.idempotencyKey,current.version,body.note,audit.user_id]);
    for(const s of consumed)await tx.query(`INSERT INTO public.production_material_debit_sources(debit_id,need_id,reservation_id,stock_movement_id)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,[debitId,s.needId,s.reservationId,s.stockMovementId]);
    if(body.successorOperationId){
      const sorted=[...current.operations].sort((a,b)=>a.phase-b.phase||a.id.localeCompare(b.id));
      const explicit=(await tx.query<{successor:string;minimum:number|null}>(`SELECT substring(successor_id from 4) AS successor,transfer_quantity::float8 AS minimum
        FROM public.planning_operation_dependencies WHERE predecessor_id='op:'||$1`,[body.operationId])).rows;
      const successor=explicit.length?explicit.find(s=>s.successor===body.successorOperationId):
        sorted[sorted.findIndex(op=>op.id===body.operationId)+1]?.id===body.successorOperationId?{successor:body.successorOperationId,minimum:null}:null;
      if(!successor||body.good<=0||!sorted.some(op=>op.id===body.successorOperationId))
        throw new HttpError(422,'MATERIAL_TRANSFER_SUCCESSOR_INVALID','Choisissez une étape suivante de cet OF et une quantité bonne positive.');
      if(successor.minimum&&body.good<successor.minimum)
        throw new HttpError(409,'MATERIAL_TRANSFER_MINIMUM',`Le lot de transfert exige ${successor.minimum} pièces minimum.`);
      await tx.query(`INSERT INTO public.production_transfer_batches(operation_id,successor_operation_id,quantity,released_quantity,material_debit_id,created_by)
        VALUES($1::uuid,$2::uuid,$3,$3,$4::uuid,$5)`,[body.operationId,body.successorOperationId,body.good,debitId,audit.user_id]);
    }
    return {coverage:await readMaterialTx(tx,ofId),debitId,declarationId:declaration.id,consumed};
  });
}
