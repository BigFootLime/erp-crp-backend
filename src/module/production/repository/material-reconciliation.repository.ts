import {HttpError} from '../../../utils/httpError';
import {materialCommand,readMaterialTx} from './of-material.repository';
import {readOfDossierTx} from './of-dossier.repository';
import type {MaterialReconciliation} from '../validators/of-material.validators';
import type {AuditContext} from './production.repository';

export async function reconcileMaterialRevision(ofId:number,body:MaterialReconciliation,audit:AuditContext){
  return materialCommand(ofId,'RECONCILE_REVISION',body,audit,async(tx,current)=>{
    const dossier=await readOfDossierTx(tx,ofId);
    if(['TERMINE','ANNULE'].includes(dossier.executionStatus))throw new HttpError(409,'MATERIAL_OF_CLOSED','Cet OF est terminé ou annulé ; ses engagements restent consultables.');
    const previous=current.previousNeeds.find(n=>n.id===body.previousNeedId);
    if(!previous)throw new HttpError(409,'MATERIAL_REVISION_ALREADY_REVIEWED','Ce besoin a déjà été rapproché ou n’appartient pas à une ancienne définition de cet OF.');
    const target=body.targetNeedId?previous.targets.find(n=>n.id===body.targetNeedId):null;
    if(body.disposition==='CARRY'&&(!target||target.blockers.length))
      throw new HttpError(409,'MATERIAL_REVISION_INCOMPATIBLE',target?.blockers.join(' ')||'Préparez le besoin de la définition actuelle avant de reprendre sa couverture.');
    await tx.query(`INSERT INTO public.of_material_revision_resolutions(of_id,previous_need_id,target_need_id,disposition,reason,reviewed_snapshot,command_key,created_by)
      VALUES($1,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::uuid,$8)`,[ofId,previous.id,body.targetNeedId,body.disposition,body.reason,
      JSON.stringify({previous:{id:previous.id,designation:previous.designation,technicalVersion:previous.technical_version_id,requirements:previous.requirements,
        reserved:previous.reserved,consumed:previous.consumed,expected:previous.expected,receivedBlocked:previous.receivedBlocked,
        reservationIds:previous.reservations.map(r=>r.id),purchaseIds:previous.promises.map(p=>p.command_id),customerCallIds:previous.customerCalls.map(c=>c.id)},
        target:target?{id:target.id,designation:target.designation,required:target.required}:null,technicalVersion:current.technicalVersion,technicalHash:current.technicalHash}),body.idempotencyKey,audit.user_id]);
    await tx.query("UPDATE public.of_dossier_validations SET invalidated_at=now(),invalidation_reason='Les engagements matière de la définition précédente ont été rapprochés.' WHERE of_id=$1 AND invalidated_at IS NULL",[ofId]);
    return readMaterialTx(tx,ofId);
  });
}
