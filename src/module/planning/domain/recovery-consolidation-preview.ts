import type { CentralSnapshot, CentralTask, Estimate, ScheduleChange } from '../types/planning-central.types';
import { schedule } from './central-scheduler';
import { dependencyClosure } from './central-dependencies';
import { quantity } from '../../production/domain/of-material';
import type { ExternalServicePreparation } from '../../subcontract/subcontract-flow.types';

export type RecoveryExternalPreparations = Map<string,{preparations:ExternalServicePreparation[];issues:string[]}>;

export type RecoveryGroupingOf = {
  id: number; number: string; clientId: string | null; articleId: string | null;
  pieceId: string | null; versionId: string | null; technicalHash: string | null;
  quantity: number; status: string; ready: boolean; operationIds: string[];
};
export type RecoveryGroupingIssue = { code: string; message: string; task_id?: string; of_id?: number };
export type RecoveryGroupingEvidence = {
  recovery: RecoveryGroupingOf; producer: RecoveryGroupingOf;
  requestStatus: string; groupingActive: boolean; recoveryAlreadyCovered: boolean;
  originalIdentityMatches: boolean; sameClientSources: boolean;
  deadlines: Array<{ of_id: number; label: string; before: string | null }>;
  issues: RecoveryGroupingIssue[];
};
const instant = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
const validInterval = (task: CentralTask) => !!task.committed && Number.isFinite(instant(task.committed.start))
  && instant(task.committed.end) > instant(task.committed.start);

/** Additional pieces consume additional productive time, never a second setup
 * or a reset of the existing progress/learning evidence. */
function extendEstimate(estimate: Estimate | null, additional: number, resume = false): Estimate | null {
  if (!estimate || !Number.isFinite(estimate.unitMinutes) || estimate.unitMinutes <= 0
    || !Number.isFinite(estimate.remainingMinutes) || estimate.remainingMinutes < 0) return null;
  if (resume && (!Number.isFinite(estimate.setupMinutes) || estimate.setupMinutes < 0)) return null;
  const remainingMinutes = (resume ? estimate.setupMinutes : estimate.remainingMinutes) + additional * estimate.unitMinutes;
  return Number.isFinite(remainingMinutes) ? { ...estimate, remainingMinutes } : null;
}

/** Read-only preview. Application must reread every source and keep the actual
 * operation IDs, starts, counters, reservations and client promises unchanged. */
export function previewRecoveryConsolidation(input: {
  snapshot: CentralSnapshot; evidence: RecoveryGroupingEvidence; now: string;
  externalPreparations?: RecoveryExternalPreparations;
}) {
  const { snapshot, evidence, now } = input, { recovery, producer } = evidence;
  const issues: RecoveryGroupingIssue[] = [...evidence.issues];
  const issue = (code: string, message: string, task_id?: string) => issues.push({ code, message, ...(task_id ? { task_id } : {}) });
  if (!['WAITING_PLANNER','APPROVED','WITHDRAWN'].includes(evidence.requestStatus)) issue('RECOVERY_CLOSED','La demande urgente est annulée.');
  if (!evidence.groupingActive || !['BROUILLON','PLANIFIE','EN_COURS','EN_PAUSE'].includes(producer.status))
    issue('GROUPING_CLOSED','Ce regroupement ne peut plus recevoir de pièces supplémentaires.');
  if (recovery.status !== 'BROUILLON' || evidence.recoveryAlreadyCovered)
    issue('RECOVERY_ENGAGED','Conservez les engagements de cet OF de récupération ou préparez un nouvel OF brouillon.');
  if (!evidence.originalIdentityMatches) issue('RECOVERY_IDENTITY_CHANGED','La commande, l’affaire ou la quantité de récupération ne correspond plus au prélèvement.');
  if (!evidence.sameClientSources) issue('GROUPING_OTHER_CLIENT','Le regroupement couvre aussi un autre client. Gardez un OF séparé.');
  if (['clientId','articleId','pieceId','versionId','technicalHash'].some(key => {
    const field = key as 'clientId'|'articleId'|'pieceId'|'versionId'|'technicalHash';
    return !recovery[field] || recovery[field] !== producer[field];
  })) issue('GROUPING_DEFINITION_MISMATCH','La PT, l’indice, la gamme et les exigences doivent être exactement identiques.');
  if (!recovery.ready || !producer.ready) issue('GROUPING_DOSSIER_INCOMPLETE','Validez les deux dossiers avant de calculer le regroupement.');
  if (![recovery.quantity,producer.quantity].every(q=>Number.isFinite(q)&&q>0)) issue('GROUPING_QUANTITY_INVALID','Quantité de fabrication à vérifier.');
  if (!Number.isFinite(instant(now)) || snapshot.nextCursor || snapshot.stale)
    issue('GROUPING_SNAPSHOT_INCOMPLETE','Actualisez le planning complet avant de calculer cet ajout.');
  if (!['SIMULATE','COMMIT','EXECUTE','LEARN'].includes(snapshot.activation)) issue('GROUPING_PLANNING_DISABLED','Activez la simulation du planning.');
  const selected = snapshot.tasks.filter(t=>t.ofId===producer.id&&t.source==='OPERATION');
  const source = snapshot.tasks.filter(t=>t.ofId===recovery.id&&t.source==='OPERATION');
  for (const [of,tasks] of [[producer,selected],[recovery,source]] as const) {
    if (!of.operationIds.length || tasks.length !== of.operationIds.length || of.operationIds.some(id=>!tasks.some(t=>t.operationId===id)))
      issue('GROUPING_OPERATIONS_MISSING',`${of.number} : les opérations ne sont pas toutes disponibles.`);
  }
  if (source.some(t=>t.actual||t.committed||t.good>0||t.scrap>0||t.rework>0||t.released>0||t.commitment!=='FORECAST'))
    issue('RECOVERY_ENGAGED','L’OF de récupération a déjà des opérations engagées. Gardez son parcours séparé.');
  const cuts = selected.filter(t=>t.operationType==='DECOUPE');
  if (!cuts.length && selected.some(t=>t.actual||t.commitment==='STARTED'||t.commitment==='DONE'))
    issue('GROUPING_NO_CUTTING_GATE','Ce regroupement engagé n’a pas de découpe identifiable. Gardez un OF séparé.');
  if (cuts.some(t=>t.commitment==='DONE'||t.actual?.end)) issue('GROUPING_CUTTING_FINISHED','La découpe est terminée : préparez un OF séparé.');
  const resumed = new Set(selected.filter(t=>t.operationType!=='DECOUPE'&&(t.commitment==='DONE'||t.actual?.end)).map(t=>t.id));
  for (const task of selected.filter(t=>resumed.has(t.id))) {
    if (task.commitment!=='DONE'||!Number.isFinite(instant(task.actual?.end))||instant(task.actual?.end)>instant(now))
      issue('GROUPING_COMPLETION_INCONSISTENT','Vérifiez la clôture de cette opération avant sa reprise.',task.id);
    if (!task.external && task.good!==producer.quantity)
      issue('GROUPING_COMPLETED_QUANTITY','Rapprochez les quantités de l’opération clôturée avant d’ajouter des pièces.',task.id);
    if (task.external && (!Number.isFinite(instant(task.external.fullReadyAt))||instant(task.external.fullReadyAt)>instant(now)||task.external.issues.length))
      issue('GROUPING_COMPLETED_EXTERNAL','Terminez le rapprochement de la prestation avant de préparer sa reprise.',task.id);
  }
  if (selected.some(t=>t.scrap>0||t.rework>0))
    issue('GROUPING_YIELD_UNSECURED','Traitez les rebuts ou reprises du regroupement avant d’y engager cette récupération.');
  if (!evidence.deadlines.length || evidence.deadlines.some(d=>!Number.isFinite(instant(d.before))))
    issue('GROUPING_PROMISE_MISSING','Un délai de livraison à protéger manque. Complétez l’engagement client.');
  const earliestDeadline = Math.min(...evidence.deadlines.map(d=>instant(d.before)));
  const oldFinish = selected.flatMap(t=>t.committed?[t.committed.end]:[]).sort((a,b)=>instant(a)-instant(b)).at(-1)??null;
  const base = { read_only: true as const, recovery_of_id: recovery.id, producer_of_id: producer.id,
    additional_quantity: recovery.quantity, previous_quantity: producer.quantity,
    proposed_quantity: quantity(producer.quantity+recovery.quantity), previous_finish: oldFinish,
    finish_before: Number.isFinite(earliestDeadline)?new Date(earliestDeadline).toISOString():null,
    fallback: { action: 'KEEP_SEPARATE_OF' as const, of_id: recovery.id },
    external_supplements: [...(input.externalPreparations?.values()??[])].flatMap(state=>state.preparations).map(p=>({
      operation_id:p.operationId,purchase_id:p.purchaseId,supplier_id:p.supplierId,supplier_name:p.supplierName,
      label:p.label,quantity:p.quantity,additional_quantity:recovery.quantity,
    })),
  };
  const blocked = () => ({ ...base, feasible: false, issues, changes: [] as ScheduleChange[], proposed_finish: null as string|null,
    additional_minutes: 0, operations: [] as Array<{task_id:string;phase:number|null;before_minutes:number;after_minutes:number;good:number;scrap:number;resumes_completed_operation:boolean;setup_minutes:number}> });
  const byPhase = new Map(selected.map(t=>[t.phase,t]));
  if (source.length!==selected.length || new Set(source.map(t=>t.phase)).size!==source.length || byPhase.size!==selected.length
    || selected.some(t=>t.phase==null) || source.some(t=>!byPhase.has(t.phase)||byPhase.get(t.phase)?.operationType!==t.operationType))
    issue('GROUPING_ROUTING_MISMATCH','Les phases de fabrication ne correspondent pas exactement.');
  if (issues.length) return blocked();
  const sourceMapping = new Map(source.map(t=>[t.id,byPhase.get(t.phase)!.id]));
  const targets = new Set(selected.map(t=>t.id));
  const assignedEstimate = (t: CentralTask) => t.resourceIds.length===1 ? t.resourceEstimates?.[t.resourceIds[0]]??t.estimate : t.estimate;
  const operations = selected.map(t=>({task_id:t.id,phase:t.phase??null,before_minutes:t.external||resumed.has(t.id)?0:assignedEstimate(t)?.remainingMinutes??0,
    after_minutes:t.external?0:extendEstimate(assignedEstimate(t),recovery.quantity,resumed.has(t.id))?.remainingMinutes??0,good:t.good,scrap:t.scrap,
    resumes_completed_operation:resumed.has(t.id),setup_minutes:resumed.has(t.id)&&!t.external?assignedEstimate(t)?.setupMinutes??0:0}));
  const tasks = snapshot.tasks.filter(t=>!sourceMapping.has(t.id)).map(task => {
    if (!targets.has(task.id)) return { ...task, locked:true };
    if (task.readiness!=='READY' || task.locked) issue('GROUPING_OPERATION_LOCKED','Une opération du regroupement est verrouillée ou incomplète.',task.id);
    if (task.external) {
      const prepared=input.externalPreparations?.get(task.operationId!);
      if (!prepared?.preparations.length || prepared.issues.length
        || prepared.preparations.some(p=>p.quantity!==base.proposed_quantity||!p.catalogueId))
        issue('GROUPING_EXTERNAL_CAPACITY',prepared?.issues.join(' ')||'Confirmez le fournisseur et le délai du complément dans l’OF de regroupement.',task.id);
      const resourceIds=[...new Set([...task.external.packages.map(p=>'supplier:'+p.supplierId),
        ...(prepared?.preparations??[]).map(p=>'supplier:'+p.supplierId)])];
      return {...task,quantity:base.proposed_quantity,resourceIds,eligibleResourceIds:resourceIds,
        external:{...task.external,preparations:prepared?.preparations,preparationIssues:prepared?.issues},
        commitment:'COMMITTED' as const,actual:null,locked:false,cycleStartedAt:resumed.has(task.id)?now:task.cycleStartedAt};
    }
    const estimate = extendEstimate(task.estimate,recovery.quantity,resumed.has(task.id));
    if (!estimate || !extendEstimate(assignedEstimate(task),recovery.quantity,resumed.has(task.id)))
      issue('GROUPING_DURATION_MISSING','Définissez le temps par pièce pour calculer la charge supplémentaire.',task.id);
    if (task.resourceIds.some(id=>snapshot.resources.find(r=>r.id===id)?.capacityEnabled===false))
      issue('GROUPING_RESOURCE_UNAVAILABLE','La ressource affectée est indisponible.',task.id);
    const started = !resumed.has(task.id)&&(task.commitment==='STARTED'||!!task.actual?.start);
    if (started && (!task.actual?.start||!validInterval(task)||instant(task.committed!.end)<=instant(now)))
      issue('GROUPING_RUNNING_SLOT_INVALID','Actualisez le créneau de l’opération en cours avant cet ajout.',task.id);
    return { ...task, quantity:quantity(task.quantity+recovery.quantity), estimate,
      resourceEstimates:task.resourceEstimates?Object.fromEntries(Object.entries(task.resourceEstimates).map(([id,e])=>[id,extendEstimate(e,recovery.quantity,resumed.has(task.id))??e])):undefined,
      commitment:'COMMITTED' as const, actual:null, locked:false,
    };
  });
  if (issues.length) return blocked();
  const mappedDependencies = snapshot.dependencies.map(d=>({ ...d,
    predecessorId:sourceMapping.get(d.predecessorId)??d.predecessorId,
    successorId:sourceMapping.get(d.successorId)??d.successorId,
  })).filter(d=>d.predecessorId!==d.successorId).map(d=>targets.has(d.predecessorId)&&resumed.has(d.successorId)
    ? {...d,transferQuantity:null,releasedQuantity:0} : d);
  // Remove exact duplicates only. Different transfer/lag constraints remain
  // independent and must all hold, especially for an already running batch.
  const uniqueDependencies = [...new Map(mappedDependencies.map(d=>[JSON.stringify(d),d])).values()];
  const byId = new Map(tasks.map(t=>[t.id,t]));
  let upstream: Set<string>, connected: Set<string>;
  try { upstream=dependencyClosure(uniqueDependencies,[...targets],'upstream');
    connected=dependencyClosure(uniqueDependencies,[...targets],'both'); }
  catch { issue('PLANNING_CHAIN_TOO_DENSE','La chaîne dépasse 10 000 opérations. Gardez un OF séparé.');return blocked(); }
  // Competing tasks still occupy capacity. Their unrelated dependency warnings
  // must not veto this proposal; connected downstream promises stay protected.
  const dependencies=uniqueDependencies.filter(d=>connected.has(d.predecessorId)&&connected.has(d.successorId));
  for (const id of upstream) {
    const task=byId.get(id);
    if (!task) issue('GROUPING_DEPENDENCY_MISSING','Un prérequis de fabrication est absent.',id);
    else if (!targets.has(id)&&!(task.commitment==='DONE'&&task.actual?.end)&&!task.committed)
      issue('GROUPING_DEPENDENCY_UNCOMMITTED','Un prérequis attend encore sa planification.',id);
  }
  if (issues.length) return blocked();
  const result = schedule({tasks,resources:snapshot.resources,dependencies,from:now,
    requested:selected.map(t=>({ taskId:t.id, resourceIds:byId.get(t.id)!.resourceIds,
      earliestStart:new Date(Math.max(instant(now),instant(t.committed?.start)||instant(now))).toISOString() })) });
  for (const conflict of result.conflicts) if (conflict.blocking!==false) issue(conflict.code,conflict.message,conflict.taskId);
  for (const task of selected) {
    const proposed=result.forecasts[task.id];
    if (!proposed) issue('GROUPING_OPERATION_UNSCHEDULED','Une opération ne dispose pas de créneau réalisable.',task.id);
    if (!resumed.has(task.id)&&!task.external&&(task.commitment==='STARTED'||task.actual?.start)&&proposed&&instant(proposed.start)!==instant(now))
      issue('GROUPING_RUNNING_INTERRUPTION','La charge supplémentaire obligerait à interrompre l’opération en cours.',task.id);
  }
  if (result.changes.some(c=>!targets.has(c.taskId))) issue('GROUPING_OTHER_COMMITMENT','La proposition modifierait un autre OF. Gardez un OF séparé.');
  const proposedFinish = selected.map(t=>result.forecasts[t.id]?.end).filter((v):v is string=>!!v).sort((a,b)=>instant(a)-instant(b)).at(-1)??null;
  if (proposedFinish) for (const deadline of evidence.deadlines) if (instant(proposedFinish)>=instant(deadline.before))
    issues.push({code:'GROUPING_DELIVERY_TOO_LATE',message:`${deadline.label} : la nouvelle fin dépasse le délai à protéger.`,of_id:deadline.of_id});
  // A running operation keeps its original planned and actual start. Only its
  // future finish can be extended, explicitly in the proposed change list.
  // External operations already in flight keep their historical start; the
  // canonical scheduler forecasts their new end without changing the shipment.
  const externalChanges=selected.filter(t=>t.external&&result.forecasts[t.id]&&!result.changes.some(c=>c.taskId===t.id)).map(t=>({
    taskId:t.id,before:t.committed,beforeResourceIds:t.resourceIds,after:result.forecasts[t.id],resourceIds:byId.get(t.id)!.resourceIds,
  }));
  const changes = [...result.changes,...externalChanges].filter(c=>targets.has(c.taskId)).map(change=>{
    const original=selected.find(t=>t.id===change.taskId)!;
    const after = !resumed.has(original.id)&&(original.commitment==='STARTED'||original.actual?.start)&&original.committed
      ? {...change.after,start:original.committed.start} : change.after;
    return {...change,before:original.committed,after};
  }).filter(c=>!c.before||c.before.start!==c.after.start||c.before.end!==c.after.end
    ||c.resourceIds.join('|')!==selected.find(t=>t.id===c.taskId)!.resourceIds.join('|'));
  return { ...base, feasible:issues.length===0, issues, changes, proposed_finish:proposedFinish,
    additional_minutes:operations.reduce((sum,o)=>sum+o.after_minutes-o.before_minutes,0),operations };
}
