import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { readMaterialTx } from './of-material.repository';
import { readMaterialReservationAvailabilityTx } from './material-reservation-availability.repository';
import { readMaterialOriginPolicyTx } from './of-material-policy.repository';
import { assertMaterialOriginLimit } from '../domain/of-material-policy';
import { materialRequirementForPieces, materialPropertiesFingerprint, quantity } from '../domain/of-material';
import type { RecoveryGroupingIssue } from '../../planning/domain/recovery-consolidation-preview';

/** Unlike draft regrouping, the producer can already have consumed material.
 * Its actual debits remain counted, and only unused recovery holds transfer. */
export async function readRecoveryConsolidationMaterialTx(tx: Pick<PoolClient,'query'>, producerId: number, recoveryId: number) {
  const producer=await readMaterialTx(tx,producerId),recovery=await readMaterialTx(tx,recoveryId);
  const producerAvailability=await readMaterialReservationAvailabilityTx(tx,producer);
  const recoveryAvailability=await readMaterialReservationAvailabilityTx(tx,recovery);
  const policy=await readMaterialOriginPolicyTx(tx,[producerId,recoveryId]);
  const issues:RecoveryGroupingIssue[]=[];
  const issue=(code:string,message:string,of_id?:number)=>issues.push({code,message,...(of_id?{of_id}:{})});
  try { assertMaterialOriginLimit(policy,[]); }
  catch(error) { if(!(error instanceof HttpError)||error.status>=500)throw error; issue(error.code,error.message); }
  for(const material of [producer,recovery]) {
    if(material.previousNeeds.length)issue('GROUPING_MATERIAL_RECONCILIATION','Réconciliez les besoins de l’ancien indice avant cet ajout.',material.ofId);
    if(material.needs.some(n=>!n.id||!n.reviewed||!n.operationId||!n.debitRule||!material.operations.some(op=>op.id===n.operationId)))
      issue('GROUPING_MATERIAL_PREPARATION','Complétez les exigences et la règle de débit.',material.ofId);
  }
  if(recovery.needs.some(n=>n.consumed>0))issue('RECOVERY_MATERIAL_CONSUMED','La récupération a déjà consommé de la matière. Gardez son OF séparé.',recoveryId);
  if(producer.needs.length!==recovery.needs.length)issue('GROUPING_MATERIAL_DEFINITION','Les besoins matière ne correspondent pas exactement.');
  const signature=(material:typeof producer,need:typeof producer.needs[number])=>materialPropertiesFingerprint({
    articleId:need.articleId,unit:need.unit,requirements:need.requirements,debitRule:need.debitRule,
    supplyMode:need.supplyMode,phase:material.operations.find(op=>op.id===need.operationId)?.phase,
  });
  const groups=producer.needs.flatMap(need=>{
    const extra=recovery.needs.find(n=>n.key===need.key);
    if(!extra||signature(producer,need)!==signature(recovery,extra)) {
      issue('GROUPING_MATERIAL_DEFINITION',`${need.designation} : exigences ou règle de débit différentes.`);return [];
    }
    const available=producerAvailability.get(need.key),extraAvailable=recoveryAvailability.get(extra.key);
    const blockers=[...need.blockers,...extra.blockers,...(available?.blockers??[]),...(extraAvailable?.blockers??[])];
    if(blockers.length)issue('GROUPING_MATERIAL_BLOCKED',`${need.designation} : ${[...new Set(blockers)].join(' ')}`);
    let required=0;
    try { if(!need.debitRule)throw new Error('Missing debit rule');
      required=quantity(Math.max(0,materialRequirementForPieces(need.debitRule,quantity(producer.quantity+recovery.quantity))+need.consumptionAdjustment));
    }catch {issue('GROUPING_MATERIAL_QUANTITY',`${need.designation} : quantité ou règle de débit à vérifier.`);}
    const usableProducer=available?.usable??0,usableRecovery=extraAvailable?.usable??0;
    const missing=quantity(Math.max(0,required-need.consumed-usableProducer-usableRecovery));
    if(missing>0)issue('GROUPING_MATERIAL_MISSING',`${need.designation} : réservez encore ${missing} ${need.unit??''} avant l’ajout.`);
    // Do not let excess producer stock mask an unprepared source commitment.
    if(quantity(Math.max(0,extra.required-usableRecovery))>0)
      issue('RECOVERY_MATERIAL_MISSING',`${extra.designation} : réservez la matière de l’OF de récupération.`,recoveryId);
    return [{source_ref:need.key,producer_need_id:need.id,recovery_need_id:extra.id,article_id:need.articleId,
      unit:need.unit,designation:need.designation,required,consumed:need.consumed,
      producer_reserved:usableProducer,recovery_reserved:usableRecovery,missing,
      recovery_reservation_ids:[...(extraAvailable?.reservations.keys()??[])],
    }];
  });
  return {producer,recovery,policy,groups,issues,ready:!issues.length,
    version:materialPropertiesFingerprint({producer:producer.version,recovery:recovery.version,policy,groups,issues})};
}
