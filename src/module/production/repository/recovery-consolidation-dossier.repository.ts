import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import type {AuditContext} from './production.repository';
import {evaluateOfPreparation,preparationAudit} from './production-preparation.repository';
import {generateSelfInspectionTx} from './self-inspection.repository';
import {readOfDossierTx} from './of-dossier.repository';

/** Quantity-specific documents are replaced by a new snapshot; earlier PDFs,
 * technical decisions, declarations and inspection executions stay untouched. */
export async function validateRecoveryProducerDossierTx(tx:PoolClient,producerId:number,additionId:string,validationId:string,audit:AuditContext) {
  let preparation=await evaluateOfPreparation(tx,producerId);
  if(!preparation.ready)throw new HttpError(409,'RECOVERY_DOSSIER_CHANGED','La préparation doit être complétée avant cet ajout.',{items:preparation.items});
  if(preparation.sources.quality_plan&&preparation.sources.characteristics.length) {
    preparation=await generateSelfInspectionTx(tx,producerId,preparation.of.updated_at,audit);
    if(preparation.sheet?.state!=='READY')throw new HttpError(409,'RECOVERY_INSPECTION_DOCUMENT_FAILED','La fiche d’autocontrôle actualisée n’a pas pu être préparée. Aucun ajout enregistré.');
  }
  const dossier=await readOfDossierTx(tx,producerId);
  if(!dossier.canComplete)throw new HttpError(409,'RECOVERY_DOSSIER_INCOMPLETE','Le dossier du regroupement ne peut pas être validé.',{blockers:dossier.blockers});
  await tx.query(`UPDATE public.of_dossier_validations SET invalidated_at=clock_timestamp(),
    invalidation_reason='Ajout de récupération au regroupement.' WHERE of_id=$1 AND invalidated_at IS NULL`,[producerId]);
  await tx.query(`INSERT INTO public.of_dossier_validations(id,of_id,source_hash,planning_revision,evidence,decided_by)
    SELECT $1::uuid,$2,$3,revision,$4::jsonb,$5 FROM public.planning_central_settings WHERE singleton`,
  [validationId,producerId,dossier.sourceHash,JSON.stringify({recovery_consolidation_addition_id:additionId,quantity:dossier.quantity,
    planning:dossier.planning,operations:dossier.operations,preparationHash:preparation.source_hash,rulesVersion:preparation.rules_version,
    warnings:preparation.warnings,self_inspection_sheet_id:preparation.sheet?.id??null}),audit.user_id]);
  await preparationAudit(tx,audit,producerId,'production.of.dossier.recovery-extension',{addition_id:additionId,validation_id:validationId,quantity:dossier.quantity,source_hash:dossier.sourceHash});
}
