import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import type {AuditContext} from './production.repository';
import type {MaterialTransfer} from '../validators/of-material.validators';
import {materialCommand,readMaterialTx} from './of-material.repository';

export async function releaseMaterialTransferTx(tx:PoolClient,input:{ofId:number;debitId:string;operationId:string;successorOperationId:string;quantity:number;key:string;reason:string},audit:AuditContext){
  const operations=(await tx.query<{id:string;phase:number}>(`SELECT id::text,phase FROM public.of_operations WHERE of_id=$1 AND
    (revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=revision_id AND r.statut='ACTIVE')) ORDER BY phase,id`,[input.ofId])).rows;
  const explicit=(await tx.query<{successor:string;minimum:number|null}>(`SELECT substring(successor_id from 4) AS successor,transfer_quantity::float8 AS minimum
    FROM public.planning_operation_dependencies WHERE predecessor_id='op:'||$1`,[input.operationId])).rows;
  const successor=explicit.length?explicit.find(s=>s.successor===input.successorOperationId):
    operations[operations.findIndex(op=>op.id===input.operationId)+1]?.id===input.successorOperationId?{successor:input.successorOperationId,minimum:1}:null;
  if(!successor||!operations.some(op=>op.id===input.successorOperationId))throw new HttpError(422,'MATERIAL_TRANSFER_SUCCESSOR_INVALID','Choisissez une étape suivante de cet OF.');
  const balance=(await tx.query<{good:number;released:number;edge_released:number}>(`SELECT q.qty_good::float8 AS good,
    COALESCE((SELECT sum(released_quantity) FROM public.production_transfer_batches WHERE material_debit_id=d.id),0)::float8 AS released,
    COALESCE((SELECT sum(released_quantity) FROM public.production_transfer_batches WHERE operation_id=d.operation_id AND successor_operation_id=$2::uuid),0)::float8 AS edge_released
    FROM public.production_material_debits d JOIN public.production_quantity_declarations q ON q.id=d.declaration_id
    WHERE d.id=$1::uuid AND d.of_id=$3 AND d.operation_id=$4::uuid AND d.compensates_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM public.production_material_debits c WHERE c.compensates_id=d.id)`,
    [input.debitId,input.successorOperationId,input.ofId,input.operationId])).rows[0];
  if(!balance||input.quantity<=0||!Number.isInteger(input.quantity)||input.quantity>balance.good-balance.released)
    throw new HttpError(409,'MATERIAL_TRANSFER_QUANTITY_EXCEEDED','Ce débit ne possède pas assez de bruts bons encore au poste.');
  if(balance.edge_released+input.quantity<(successor.minimum??1))throw new HttpError(409,'MATERIAL_TRANSFER_MINIMUM',`Le lot de transfert exige ${successor.minimum} pièces minimum.`);
  const transfer=(await tx.query<{id:string}>(`INSERT INTO public.production_transfer_batches(operation_id,successor_operation_id,quantity,released_quantity,material_debit_id,created_by)
    VALUES($1::uuid,$2::uuid,$3,$3,$4::uuid,$5) RETURNING id::text`,[input.operationId,input.successorOperationId,input.quantity,input.debitId,audit.user_id])).rows[0];
  await tx.query(`INSERT INTO public.production_material_transfer_events(transfer_id,command_key,action,quantity,reason,created_by)
    VALUES($1::uuid,$2::uuid,'RELEASE',$3,$4,$5)`,[transfer.id,input.key,input.quantity,input.reason,audit.user_id]);
}

export async function commandMaterialTransfer(ofId:number,body:MaterialTransfer,audit:AuditContext){
  return materialCommand(ofId,'TRANSFER',body,audit,async(tx)=>{
    const debit=(await tx.query<{operation_id:string}>(`SELECT operation_id::text FROM public.production_material_debits d WHERE d.id=$1::uuid AND of_id=$2
      AND compensates_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.production_material_debits c WHERE c.compensates_id=d.id)`,[body.debitId,ofId])).rows[0];
    if(!debit)throw new HttpError(409,'MATERIAL_DEBIT_ALREADY_CORRECTED','Ce débit est introuvable ou déjà compensé.');
    if(body.action==='RELEASE')await releaseMaterialTransferTx(tx,{ofId,debitId:body.debitId,operationId:debit.operation_id,successorOperationId:body.successorOperationId,
      quantity:body.quantity,key:body.idempotencyKey,reason:body.reason},audit);
    else {
      // A return is a physical reversal of unprocessed WIP. Never take pieces
      // away from an operation that has already started using them.
      const successor=(await tx.query<{status:string;processed:number}>(`SELECT o.status::text AS status,COALESCE((SELECT sum(qty_good+qty_scrap+qty_rework+qty_pending_control)
        FROM public.production_quantity_declarations WHERE operation_id=o.id),0)::float8 AS processed
        FROM public.of_operations o WHERE o.id=$1::uuid AND of_id=$2 FOR UPDATE OF o`,[body.successorOperationId,ofId])).rows[0];
      if(!successor||['RUNNING','DONE'].includes(successor.status)||successor.processed>0)
        throw new HttpError(409,'MATERIAL_TRANSFER_ALREADY_USED','L’étape suivante a commencé ou déclaré des pièces. Faites traiter la correction aval avant de retourner les bruts.');
      const batches=(await tx.query<{id:string;released:number}>(`SELECT id::text,released_quantity::float8 AS released FROM public.production_transfer_batches
        WHERE material_debit_id=$1::uuid AND successor_operation_id=$2::uuid AND released_quantity>0 ORDER BY created_at DESC,id DESC FOR UPDATE`,[body.debitId,body.successorOperationId])).rows;
      if(body.quantity>batches.reduce((sum,b)=>sum+b.released,0))throw new HttpError(409,'MATERIAL_TRANSFER_QUANTITY_EXCEEDED','Le retour dépasse les bruts mis à disposition de cette étape.');
      let remaining=body.quantity;
      for(const batch of batches){const take=Math.min(remaining,batch.released);if(take<=0)break;
        await tx.query('UPDATE public.production_transfer_batches SET released_quantity=released_quantity-$2,version=version+1 WHERE id=$1::uuid',[batch.id,take]);
        await tx.query(`INSERT INTO public.production_material_transfer_events(transfer_id,command_key,action,quantity,reason,created_by)
          VALUES($1::uuid,$2::uuid,'RETURN',$3,$4,$5)`,[batch.id,body.idempotencyKey,take,body.reason,audit.user_id]);remaining-=take;
      }
    }
    return {coverage:await readMaterialTx(tx,ofId)};
  });
}
