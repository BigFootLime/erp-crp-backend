import type {PoolClient} from "pg";
import pool from "../../../config/database";
import {HttpError} from "../../../utils/httpError";
import {readMaterialTx} from "./of-material.repository";
import {materialWorkflowEnabled,readOfDossierTx,type DossierDb} from "./of-dossier.repository";
import {lotCompatibility,materialPropertiesFingerprint} from "../domain/of-material";
import {assertOperationQuantityCeiling,evaluateOperationReadiness,type OperationReadinessFacts} from "../domain/operation-readiness";
import {readOperationalLotQualityEligibility,assertOperationalLotQualityEligibility} from "../../qualite/repository/quality-operational-gate.repository";

type OperationRow = {id:string;kind:string|null;machine_id:string|null;machine_status:string|null;good:number;scrap:number;pending:number;rework:number;updated_at:string;program_required:boolean;program_ready:boolean;quality_blocked:boolean};
type DependencyRow = {successor:string;predecessor:string;label:string;status:string;good:number;transferred:number;minimum:number|null;partial:boolean};

export async function usesOperationReadiness(tx:DossierDb,ofId:number){
  const installed=(await tx.query("SELECT to_regclass('public.of_dossier_validations') IS NOT NULL AS installed")).rows[0]?.installed===true;
  if(!installed)return false;
  return await materialWorkflowEnabled(tx)||(await tx.query<{guarded:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.of_dossier_validations WHERE of_id=$1)
    OR EXISTS(SELECT 1 FROM public.of_material_needs WHERE of_id=$1) AS guarded`,[ofId])).rows[0]?.guarded===true;
}

export async function readOperationReadinessTx(tx:DossierDb,ofId:number){
  const dossier=await readOfDossierTx(tx,ofId);
  const coverage=await readMaterialTx(tx,ofId);
  const operations=(await tx.query<OperationRow>(`
    SELECT op.id::text,frozen.value->>'type_operation' AS kind,op.machine_id::text,m.status::text AS machine_status,op.updated_at::text,
      COALESCE(q.good,0)::float8 AS good,COALESCE(q.scrap,0)::float8 AS scrap,COALESCE(q.pending,0)::float8 AS pending,COALESCE(q.rework,0)::float8 AS rework,
      (frozen.value->>'type_operation' IN ('FRAISAGE','TOURNAGE','REPRISE') AND COALESCE(o.technical_snapshot->'preparation_decisions'->'programming'->>'mode','')<>'NONE') AS program_required,
      (CASE o.technical_snapshot->'preparation_decisions'->'programming'->>'mode'
        WHEN 'NONE' THEN true
        WHEN 'EXISTING' THEN COALESCE(NULLIF(btrim(frozen.value->>'numero_programme'),''),NULLIF(btrim(o.technical_snapshot->'preparation_decisions'->'programming'->>'reference'),'')) IS NOT NULL
        WHEN 'TASK' THEN EXISTS(SELECT 1 FROM public.piece_version_programming_tasks pr
          WHERE pr.id::text=o.technical_snapshot->'preparation_decisions'->'programming'->>'task_id'
            AND pr.piece_technique_version_id=o.piece_technique_version_id AND pr.status='DONE' AND NULLIF(btrim(pr.program_reference),'') IS NOT NULL)
        ELSE false END)
      AS program_ready,
      (EXISTS(SELECT 1 FROM public.non_conformity nc WHERE nc.of_id=o.id AND nc.status::text NOT IN ('CLOSED','CANCELLED'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'preparation_evidence'->'documents','[]')) doc
          WHERE NOT EXISTS(SELECT 1 FROM public.ged_document_versions v WHERE v.id::text=doc->>'version_id' AND v.status='APPLICABLE'))
        OR (frozen.value->>'type_operation'='CONTROLE' AND NOT EXISTS(SELECT 1 FROM public.quality_control_plan p
          WHERE p.id::text=o.technical_snapshot->'preparation_evidence'->'quality_plan'->>'id' AND p.status='PUBLISHED'))) AS quality_blocked
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id LEFT JOIN public.machines m ON m.id=op.machine_id
    LEFT JOIN LATERAL(SELECT value FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
    LEFT JOIN LATERAL(SELECT sum(qty_good) AS good,sum(qty_scrap) AS scrap,sum(qty_pending_control) AS pending,sum(qty_rework) AS rework FROM public.production_quantity_declarations WHERE operation_id=op.id) q ON true
    WHERE op.id=ANY($1::uuid[]) ORDER BY op.phase,op.id`,[dossier.operations.map(o=>o.id)])).rows;
  const dependencies=(await tx.query<DependencyRow>(`
    WITH route AS(SELECT id,lag(id) OVER(ORDER BY phase,id) AS predecessor FROM public.of_operations WHERE id=ANY($1::uuid[])), edges AS(
      SELECT r.id AS successor,substring(d.predecessor_id from 4)::uuid AS predecessor,d.transfer_quantity AS minimum
      FROM route r JOIN public.planning_operation_dependencies d ON d.successor_id='op:'||r.id::text WHERE d.predecessor_id LIKE 'op:%'
      UNION ALL SELECT r.id,r.predecessor,NULL::numeric FROM route r WHERE r.predecessor IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM public.planning_operation_dependencies d WHERE d.successor_id='op:'||r.id::text AND d.predecessor_id LIKE 'op:%'))
    SELECT e.successor::text,e.predecessor::text,p.designation AS label,p.status::text,
      COALESCE((SELECT sum(q.qty_good) FROM public.production_quantity_declarations q WHERE q.operation_id=p.id),0)::float8 AS good,
      COALESCE((SELECT sum(b.released_quantity) FROM public.production_transfer_batches b WHERE b.operation_id=p.id AND b.successor_operation_id=e.successor),0)::float8 AS transferred,
      e.minimum::float8,(e.minimum IS NOT NULL OR EXISTS(SELECT 1 FROM public.of_material_needs n WHERE n.operation_id=p.id AND n.allow_partial AND n.superseded_at IS NULL)) AS partial
    FROM edges e JOIN public.of_operations p ON p.id=e.predecessor ORDER BY e.successor,p.phase,p.id`,[dossier.operations.map(o=>o.id)])).rows;
  let componentMissing=(await tx.query<{missing:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.of_component_requirements n
    WHERE n.consuming_of_id=$1 AND n.status NOT IN ('CANCELLED','CONSUMED') AND n.required_qty>COALESCE((
      SELECT sum(GREATEST(0,r.qty_reserved-r.qty_consumed)) FROM public.stock_reservations r WHERE r.of_component_requirement_id=n.id
        AND r.status='ACTIVE' AND(r.expires_at IS NULL OR r.expires_at>now())),0)) AS missing`,[ofId])).rows[0]?.missing===true;
  const materialFacts=new Map<string,OperationReadinessFacts['materials']>();
  const quality=new Map<string,Awaited<ReturnType<typeof readOperationalLotQualityEligibility>>>();
  if(operations.some(op=>op.kind==='ASSEMBLAGE')){
    const components=(await tx.query<{lot_id:string|null;physical:boolean}>(`SELECT r.lot_id::text,
      (l.lot_status='LIBERE' AND b.qty_total-b.qty_depreciated>=b.qty_reserved AND r.article_id=l.article_id) AS physical
      FROM public.stock_reservations r JOIN public.of_component_requirements n ON n.id=r.of_component_requirement_id
      LEFT JOIN public.stock_batches b ON b.id=r.stock_batch_id LEFT JOIN public.lots l ON l.id=r.lot_id
      WHERE n.consuming_of_id=$1 AND n.status NOT IN ('CANCELLED','CONSUMED') AND r.status='ACTIVE'
        AND(r.expires_at IS NULL OR r.expires_at>now()) ORDER BY r.lot_id,r.id`,[ofId])).rows;
    for(const component of components){
      if(!component.lot_id||!component.physical){componentMissing=true;continue;}
      if(!quality.has(component.lot_id))quality.set(component.lot_id,await readOperationalLotQualityEligibility({client:tx,lotId:component.lot_id,qty:0,purpose:'RESERVE'}));
      if(quality.get(component.lot_id)!.eligibility.blocks.length)componentMissing=true;
    }
  }
  for(const need of coverage.needs){
    if(!need.operationId)continue;
    const reasons=[...need.blockers];
    let usable=0;
    for(const reservation of need.reservations){
      if(reservation.status!=='ACTIVE'||!reservation.unexpired||Number(reservation.qty_reserved)<=Number(reservation.qty_consumed))continue;
      const candidate=need.candidates.find(c=>c.lot.id===reservation.lot_id&&c.lot.batchId===reservation.stock_batch_id);
      if(!candidate){reasons.push('Le lot réservé n’est plus physiquement disponible.');continue;}
      if(!quality.has(candidate.lot.id))quality.set(candidate.lot.id,await readOperationalLotQualityEligibility({client:tx,lotId:candidate.lot.id,qty:0,unit:need.unit,purpose:'RESERVE'}));
      const decision=quality.get(candidate.lot.id)!;
      const incompatible=lotCompatibility(need,{...candidate.lot,qualityBlocks:decision.eligibility.blocks.map(b=>b.message)});
      if(incompatible.length)reasons.push(...incompatible);
      else usable+=Math.max(0,Number(reservation.qty_reserved)-Number(reservation.qty_consumed));
    }
    const perBlank=need.debitRule ? need.debitRule.unitsPerBlank+need.debitRule.kerfPerBlank : 0;
    const entry={label:need.designation,availableBlanks:perBlank>0?Math.floor((usable+need.consumed)/perBlank+1e-9):0,allowPartial:need.allowPartial,blockers:[...new Set(reasons)]};
    materialFacts.set(need.operationId,[...(materialFacts.get(need.operationId)??[]),entry]);
  }
  const statuses=['HORS_SERVICE','OUT_OF_SERVICE','MAINTENANCE','EN_MAINTENANCE','IN_MAINTENANCE','INDISPONIBLE'];
  const results=dossier.operations.map(op=>{
    const row=operations.find(r=>r.id===op.id);
    const facts:OperationReadinessFacts={id:op.id,label:op.label,phase:op.phase,status:op.status,targetQuantity:dossier.quantity,
      processedQuantity:Number(row?.good??0)+Number(row?.scrap??0)+Number(row?.pending??0)+Number(row?.rework??0),dossierComplete:dossier.status==='COMPLETE',executionStatus:dossier.executionStatus,
      planned:op.planned||['RUNNING','DONE'].includes(op.status),machineBlocked:statuses.includes(row?.machine_status??''),
      preparationMissing:coverage.needs.some(n=>!n.id||!n.operationId||!n.reviewed)||coverage.previousNeeds.length>0,
      programRequired:row?.program_required===true,programReady:row?.program_ready===true,qualityBlocked:!row||row.quality_blocked,
      componentsMissing:row?.kind==='ASSEMBLAGE'&&componentMissing,materials:materialFacts.get(op.id)??[],
      predecessors:dependencies.filter(d=>d.successor===op.id).map(d=>({id:d.predecessor,label:d.label,done:d.status==='DONE',good:d.good,transferred:Math.min(d.good,d.transferred),partial:d.partial,minimum:d.minimum??1}))};
    return {...evaluateOperationReadiness(facts),machineId:row?.machine_id??null,materialOperation:facts.materials.length>0,
      successors:dependencies.filter(d=>d.predecessor===op.id).flatMap(d=>{const next=dossier.operations.find(o=>o.id===d.successor);return next?[{id:next.id,label:next.label,minimum:d.minimum??1}]:[]})};
  });
  return {enabled:true as const,ofId,number:dossier.number,version:materialPropertiesFingerprint({coverage:coverage.version,operations,dependencies,componentMissing,quality:[...quality].map(([id,q])=>[id,q.target,q.already_committed_qty]),results}),operations:results};
}

export async function getOperationReadiness(ofId:number){
  const tx=await pool.connect();
  try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await usesOperationReadiness(tx,ofId)?await readOperationReadinessTx(tx,ofId):{enabled:false as const};await tx.query('COMMIT');return result;}
  catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}

/** Called before OF/pointage locks. The canonical gate rechecks quality under
 * lot locks so a concurrent quarantine cannot race a successful start. */
export async function assertMaterialOperationStartTx(tx:PoolClient,ofId:number,operationId:string|null|undefined,expectedVersion?:string,machineId?:string|null){
  if(!await usesOperationReadiness(tx,ofId))return null;
  await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
  await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE',[ofId]);
  if(!operationId)throw new HttpError(409,'OPERATION_REQUIRED','Choisissez l’opération à démarrer dans le dossier OF.');
  const reservations=(await tx.query<{lot_id:string}>(`SELECT DISTINCT r.lot_id::text FROM public.stock_reservations r
    LEFT JOIN public.of_material_needs n ON n.id=r.material_need_id
    LEFT JOIN public.of_component_requirements c ON c.id=r.of_component_requirement_id
    WHERE r.status='ACTIVE' AND r.lot_id IS NOT NULL AND(r.expires_at IS NULL OR r.expires_at>now()) AND
      ((n.of_id=$1 AND n.operation_id=$2::uuid) OR(c.consuming_of_id=$1 AND EXISTS(SELECT 1 FROM public.of_operations op
        JOIN public.ordres_fabrication o ON o.id=op.of_id CROSS JOIN LATERAL jsonb_array_elements(o.technical_snapshot->'operations') f
        WHERE op.id=$2::uuid AND f->>'phase'=op.phase::text AND f->>'type_operation'='ASSEMBLAGE'))) ORDER BY 1`,[ofId,operationId])).rows;
  for(const r of reservations)await assertOperationalLotQualityEligibility({client:tx,lotId:r.lot_id,qty:0,purpose:'RESERVE'});
  const current=await readOperationReadinessTx(tx,ofId);
  if(expectedVersion&&expectedVersion!==current.version)throw new HttpError(409,'OPERATION_READINESS_CHANGED','La matière, le programme ou le planning a changé. Relisez les disponibilités avant de démarrer.');
  const operation=current.operations.find(o=>o.id===operationId);
  if(!operation)throw new HttpError(404,'OF_OPERATION_NOT_FOUND','Opération introuvable dans cet OF.');
  if(machineId&&machineId!==operation.machineId)throw new HttpError(409,'OPERATION_RESOURCE_CHANGED','Cette machine ne correspond pas à l’affectation de l’opération. Faites valider sa réaffectation dans le planning.');
  if(!operation.canStart)throw new HttpError(409,'OPERATION_NOT_READY','Cette opération ne peut pas encore démarrer.',{operation});
  return {version:current.version,operation};
}

/** Lock before execution context, including for offline replay. Recording actual
 * work is distinct from starting again: a later incident must remain reportable. */
export async function lockMaterialExecutionTx(tx:PoolClient,ofId:number){
  const enabled=await usesOperationReadiness(tx,ofId);
  if(enabled){
    await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
    await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE',[ofId]);
  }
  return enabled;
}

export async function assertMaterialQuantityTx(tx:DossierDb,ofId:number,operationId:string|null,delta:{qty_good:number;qty_scrap:number;qty_pending_control:number;qty_rework:number}){
  if(!operationId)throw new HttpError(409,'OPERATION_REQUIRED','Choisissez l’opération concernée par cette déclaration.');
  const current=await readOperationReadinessTx(tx,ofId);
  const operation=current.operations.find(o=>o.id===operationId);
  if(!operation)throw new HttpError(404,'OF_OPERATION_NOT_FOUND','Opération introuvable dans cet OF.');
  const coverage=await readMaterialTx(tx,ofId);
  const needs=coverage.needs.filter(n=>n.operationId===operationId);
  const consumedAvailable=needs.length?Math.max(0,Math.min(...needs.map(n=>{
    const perBlank=n.debitRule?n.debitRule.unitsPerBlank+n.debitRule.kerfPerBlank:0;
    return perBlank>0?Math.floor(n.consumed/perBlank+1e-9)-operation.processedQuantity:0;
  }))):null;
  const state=(await tx.query<{status:string}>('SELECT statut::text AS status FROM public.ordres_fabrication WHERE id=$1',[ofId])).rows[0];
  assertOperationQuantityCeiling({executionStatus:state?.status??'',operationStatus:operation.status,available:operation.availableQuantity,consumedAvailable,
    good:delta.qty_good,scrap:delta.qty_scrap,pending:delta.qty_pending_control,rework:delta.qty_rework});
  return {operation,version:current.version};
}

/** OF output is the final routing operation. Intermediate pieces stay WIP. */
export async function syncMaterialOfQuantitiesTx(tx:DossierDb,ofId:number,actorId:number){
  await tx.query(`WITH active AS(SELECT op.id,op.phase FROM public.of_operations op WHERE op.of_id=$1 AND
      (op.revision_id IS NULL OR EXISTS(SELECT 1 FROM public.of_revisions r WHERE r.id=op.revision_id AND r.statut='ACTIVE'))),
    final AS(SELECT id FROM active ORDER BY phase DESC,id DESC LIMIT 1),
    totals AS(SELECT COALESCE(sum(d.qty_good) FILTER(WHERE d.operation_id=(SELECT id FROM final)),0) AS good,
      COALESCE(sum(d.qty_scrap),0) AS scrap FROM public.production_quantity_declarations d JOIN active a ON a.id=d.operation_id)
    UPDATE public.ordres_fabrication o SET quantite_bonne=totals.good,quantite_rebut=totals.scrap,updated_at=now(),updated_by=$2 FROM totals WHERE o.id=$1`,[ofId,actorId]);
}
