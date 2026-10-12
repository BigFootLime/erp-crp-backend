import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { readRecoveryConsolidationContextTx } from './recovery-consolidation-context.repository';
import { readRecoveryConsolidationMaterialTx } from '../../production/repository/recovery-consolidation-material.repository';
import { readOfComponentCoverageTx } from '../../production/repository/of-component-coverage.repository';
import { readUrgencyRecoveryScopesTx } from '../../production/repository/urgency-recovery-scope.repository';
import { readCentralDependencies, readCentralSnapshot } from './planning-central.repository';
import { dependencyClosure } from '../domain/central-dependencies';
import { previewRecoveryConsolidation, type RecoveryGroupingIssue } from '../domain/recovery-consolidation-preview';

/** The same transaction sees the promises, material, calendars and operations.
 * This endpoint never changes quantities, commitments, reservations or approval. */
export async function readRecoveryConsolidationPreviewTx(
  tx: Pick<PoolClient,'query'>, recoveryId: string, groupingId: string, now = new Date().toISOString(),
) {
  const context = await readRecoveryConsolidationContextTx(tx,recoveryId,groupingId);
  const { recovery, producer } = context;
  const material = await readRecoveryConsolidationMaterialTx(tx,producer.id,recovery.id);
  const issues: RecoveryGroupingIssue[] = [...context.issues,...material.issues];
  const related = await readUrgencyRecoveryScopesTx(tx,[producer.id],['WAITING_PLANNER','CANCELLED']);
  if (related.some(r=>r.request_id!==context.context.request_id || r.status==='CANCELLED'))
    issues.push({code:'GROUPING_RECOVERY_PENDING',message:'Une autre récupération de ce regroupement attend sa validation ou sa réconciliation.'});
  const ids = [material.producer,material.recovery].flatMap(m=>m.operations.map(op=>`op:${op.id}`));
  const dependencies = await readCentralDependencies(tx);
  let included: string[];
  try { included=[...dependencyClosure(dependencies,ids,'both')]; }
  catch { throw new HttpError(422,'PLANNING_CHAIN_TOO_DENSE','Cette chaîne dépasse 10 000 opérations.'); }
  const from = new Date(new Date(now).setUTCHours(0,0,0,0)).toISOString();
  const maximum = Math.max(Date.parse(now)+86400000,...context.deadlines.flatMap(d=>d.before&&Number.isFinite(Date.parse(d.before))?[Date.parse(d.before)]:[]));
  const to = new Date(Math.min(maximum+86400000,Date.parse(from)+367*86400000)).toISOString();
  const query = {from,to,limit:10000,includeTaskIds:included};
  const selected = await readCentralSnapshot({...query,taskIdsOnly:true},tx,false);
  const resourceIds = new Set(selected.tasks.flatMap(t=>t.resourceIds));
  const capacities = new Set(selected.resources.filter(r=>resourceIds.has(r.id)).map(r=>r.capacityId??r.id));
  const capacityResourceIds = selected.resources.filter(r=>resourceIds.has(r.id)||capacities.has(r.capacityId??r.id)).map(r=>r.id);
  const snapshot = await readCentralSnapshot({...query,capacityResourceIds},tx,false);
  if (selected.nextCursor) issues.push({code:'GROUPING_SNAPSHOT_INCOMPLETE',message:'La chaîne dépasse la fenêtre de contrôle.'});
  const components = [];
  for (const of of [producer,recovery]) {
    const assembly = selected.tasks.some(t=>t.ofId===of.id&&t.operationType==='ASSEMBLAGE');
    const coverage = await readOfComponentCoverageTx(tx,of.id,assembly?true:undefined);
    components.push(coverage);
    if (!coverage.ready) issues.push({code:'GROUPING_COMPONENTS_MISSING',of_id:of.id,
      message:`${of.number} : préparez et réservez les sous-pièces avant cet ajout.`});
    if (of.id===recovery.id&&coverage.items.some(i=>i.consumedQuantity>0))
      issues.push({code:'RECOVERY_COMPONENTS_CONSUMED',of_id:of.id,message:'La récupération a déjà consommé des sous-pièces. Gardez son OF séparé.'});
  }
  const evidence = {
    recovery:{...recovery,ready:material.recovery.dossierStatus==='COMPLETE',operationIds:material.recovery.operations.map(o=>o.id)},
    producer:{...producer,ready:material.producer.dossierStatus==='COMPLETE',operationIds:material.producer.operations.map(o=>o.id)},
    requestStatus:context.context.request_status,groupingActive:context.context.grouping_state==='ACTIVE',
    recoveryAlreadyCovered:recovery.covered,originalIdentityMatches:context.originalIdentityMatches,
    sameClientSources:context.sameClientSources,deadlines:context.deadlines,issues,
  };
  const preview = previewRecoveryConsolidation({snapshot,evidence,now});
  const previewHash = createHash('sha256').update(JSON.stringify({context,material:material.version,
    components:components.map(c=>[c.ofId,c.version]),revision:snapshot.revision,
    tasks:snapshot.tasks.map(t=>[t.id,t.version,t.committed,t.actual,t.resourceIds]),
    resources:snapshot.resources.map(r=>[r.id,r.version]),dependencies:snapshot.dependencies,
  })).digest('hex');
  return {...preview,request_id:context.context.request_id,request_version:context.context.request_version,
    recovery_id:recoveryId,consolidation_id:groupingId,recovery_number:recovery.number,producer_number:producer.number,
    planning_revision:snapshot.revision,preview_hash:previewHash,checked_at:now,
    deadlines:context.deadlines,
    material:{ready:material.ready,origins:material.policy.usedOrigins.length,maximum_origins:material.policy.maximumLots,
      needs:material.groups.map(({recovery_reservation_ids,...need})=>need)},
    components:components.map(c=>({of_id:c.ofId,ready:c.ready,missing:c.items.reduce((sum,i)=>sum+i.missing,0)})),
  };
}

export async function previewRecoveryGrouping(recoveryId:string,groupingId:string) {
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await readRecoveryConsolidationPreviewTx(tx,recoveryId,groupingId);
    await tx.query('COMMIT');return result;
  } catch(error) { await tx.query('ROLLBACK');throw error; }
  finally {tx.release();}
}
