import type {PoolClient} from "pg";
import pool from "../../../config/database";
import {HttpError} from "../../../utils/httpError";
import {readMaterialTx} from "./of-material.repository";
import {materialWorkflowEnabled,readOfDossierTx,type DossierDb} from "./of-dossier.repository";
import {materialPropertiesFingerprint} from "../domain/of-material";
import {readMaterialReservationAvailabilityTx,type MaterialReservationAvailability} from './material-reservation-availability.repository';
import {assertOperationQuantityCeiling,evaluateOperationReadiness,type OperationReadinessFacts} from "../domain/operation-readiness";
import {assertOperationalLotQualityEligibility} from "../../qualite/repository/quality-operational-gate.repository";
import {readOfComponentCoverageTx} from './of-component-coverage.repository';
import {readSubcontractFlows,readExternalTransfers,subcontractFlowInstalled} from '../../subcontract/subcontract-flow.repository';
import {assertMaterialOriginLimit,missingPhysicalMaterial} from '../domain/of-material-policy';

type OperationRow = {id:string;kind:string|null;machine_id:string|null;machine_status:string|null;machine_unavailable:boolean;good:number;scrap:number;pending:number;rework:number;updated_at:string;program_required:boolean;program_ready:boolean;quality_blocked:boolean;inspection_missing:boolean};
type DependencyRow = {successor:string;predecessor:string;label:string;status:string;good:number;transferred:number;minimum:number|null;partial:boolean};

export async function usesOperationReadiness(tx:DossierDb,ofId:number){
  const installed=(await tx.query("SELECT to_regclass('public.of_dossier_validations') IS NOT NULL AS installed")).rows[0]?.installed===true;
  if(!installed)return false;
  return await materialWorkflowEnabled(tx)||(await tx.query<{guarded:boolean}>(`SELECT EXISTS(SELECT 1 FROM public.of_dossier_validations WHERE of_id=$1)
    OR EXISTS(SELECT 1 FROM public.of_material_needs WHERE of_id=$1) AS guarded`,[ofId])).rows[0]?.guarded===true;
}

export async function readOperationReadinessTx(tx:DossierDb,ofId:number,material?:Awaited<ReturnType<typeof readMaterialTx>>,reservationAvailability?:MaterialReservationAvailability){
  const dossier=await readOfDossierTx(tx,ofId);
  const coverage=material??await readMaterialTx(tx,ofId);
  const operations=(await tx.query<OperationRow>(`
    SELECT op.id::text,frozen.value->>'type_operation' AS kind,op.machine_id::text,m.status::text AS machine_status,op.updated_at::text,
      (m.archived_at IS NOT NULL OR m.is_available IS FALSE OR EXISTS(SELECT 1 FROM public.production_maintenance_holds h WHERE h.machine_id=m.id AND h.resolved_at IS NULL) OR EXISTS(SELECT 1 FROM public.production_machine_unavailability u JOIN public.planning_events e ON e.id=u.planning_event_id WHERE u.machine_id=m.id AND u.archived_at IS NULL AND e.archived_at IS NULL AND e.status NOT IN ('DONE','CANCELLED') AND e.start_ts<=statement_timestamp() AND e.end_ts>statement_timestamp())) AS machine_unavailable,
      COALESCE(q.good,0)::float8 AS good,COALESCE(q.scrap,0)::float8 AS scrap,COALESCE(q.pending,0)::float8 AS pending,COALESCE(q.rework,0)::float8 AS rework,
       (frozen.value->>'type_operation' IN ('FRAISAGE','TOURNAGE','REPRISE') AND (COALESCE(programming.value->>'mode','')<>'NONE'
         OR length(btrim(COALESCE(programming.value->>'reason','')))<3)) AS program_required,
       (CASE programming.value->>'mode'
         WHEN 'NONE' THEN length(btrim(COALESCE(programming.value->>'reason','')))>=3
         WHEN 'EXISTING' THEN COALESCE(NULLIF(btrim(frozen.value->>'numero_programme'),''),NULLIF(btrim(programming.value->>'reference'),'')) IS NOT NULL
        WHEN 'TASK' THEN EXISTS(SELECT 1 FROM public.piece_version_programming_tasks pr
           WHERE pr.id::text=programming.value->>'task_id'
            AND pr.piece_technique_version_id=o.piece_technique_version_id AND (pr.of_id IS NULL OR pr.of_id=o.id)
            AND pr.status='DONE' AND NULLIF(btrim(pr.program_reference),'') IS NOT NULL)
         ELSE NULLIF(btrim(frozen.value->>'numero_programme'),'') IS NOT NULL END)
      AS program_ready,
      (EXISTS(SELECT 1 FROM public.non_conformity nc WHERE nc.of_id=o.id AND nc.status::text NOT IN ('CLOSED','CANCELLED'))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'preparation_evidence'->'documents','[]')) doc
          WHERE NOT EXISTS(SELECT 1 FROM public.ged_document_versions v WHERE v.id::text=doc->>'version_id' AND v.status='APPLICABLE'))
        OR (frozen.value->>'type_operation'='CONTROLE' AND NOT EXISTS(SELECT 1 FROM public.quality_control_plan p
           WHERE p.id::text=COALESCE(o.technical_snapshot->'preparation_evidence'->'quality_plan'->>'id',o.technical_preparation->'execution_quality'->'quality_plan'->>'id')
             AND p.piece_version_id=o.piece_technique_version_id AND p.status='PUBLISHED' AND p.archived_at IS NULL
             AND (p.effective_from IS NULL OR p.effective_from<=now()) AND (p.effective_to IS NULL OR p.effective_to>now())))) AS quality_blocked,
       (o.preparation_rules_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.of_self_inspection_sheets s
         WHERE s.id::text=o.technical_preparation->>'self_inspection_sheet_id' AND s.of_id=o.id AND s.state='READY'
           AND s.piece_technique_version_id=o.piece_technique_version_id AND (s.snapshot->'of'->>'quantite_lancee')::numeric=o.quantite_lancee)) AS inspection_missing
    FROM public.of_operations op JOIN public.ordres_fabrication o ON o.id=op.of_id LEFT JOIN public.machines m ON m.id=op.machine_id
     LEFT JOIN LATERAL(SELECT value FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'operations','[]')) WHERE value->>'phase'=op.phase::text LIMIT 1) frozen ON true
     CROSS JOIN LATERAL(SELECT COALESCE(o.technical_preparation->'execution_programming',o.technical_snapshot->'preparation_decisions'->'programming') AS value) programming
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
  const external=await readSubcontractFlows(tx,[...new Set(dependencies.map(d=>d.predecessor))]);
  const externalTransfers=await readExternalTransfers(tx,external);
  const materialFacts=new Map<string,OperationReadinessFacts['materials']>();
  const componentCoverage=operations.some(op=>op.kind==='ASSEMBLAGE')?await readOfComponentCoverageTx(tx,ofId,true):null;
  const componentMissing=componentCoverage!==null&&!componentCoverage.ready;
  const availableReservations=reservationAvailability??await readMaterialReservationAvailabilityTx(tx,coverage);
  const missingMaterial=missingPhysicalMaterial(coverage.needs.map(need=>({key:need.key,designation:need.designation,
    unit:need.unit,required:need.required,consumed:need.consumed,usableReserved:availableReservations.get(need.key)?.usable??0,
    blockers:[...need.blockers,...(availableReservations.get(need.key)?.blockers??[])]})));
  let originBlock:string|null=null;
  try{assertMaterialOriginLimit(coverage.originPolicy,[]);}catch(error){if(!(error instanceof HttpError))throw error;originBlock=error.message;}
  for(const need of coverage.needs){
    if(!need.operationId)continue;
    const available=availableReservations.get(need.key)!;
    const reasons=[...need.blockers,...available.blockers],usable=available.usable;
    const perBlank=need.debitRule ? need.debitRule.unitsPerBlank+need.debitRule.kerfPerBlank : 0;
    const entry={label:need.designation,availableBlanks:perBlank>0?Math.floor((usable+need.consumed-(need.consumptionAdjustment??0))/perBlank+1e-9):0,allowPartial:need.allowPartial,blockers:[...new Set(reasons)]};
    materialFacts.set(need.operationId,[...(materialFacts.get(need.operationId)??[]),entry]);
  }
  const statuses=['HORS_SERVICE','OUT_OF_SERVICE','MAINTENANCE','EN_MAINTENANCE','IN_MAINTENANCE','INDISPONIBLE'];
  const results=dossier.operations.map(op=>{
    const row=operations.find(r=>r.id===op.id);
    const facts:OperationReadinessFacts={id:op.id,label:op.label,phase:op.phase,status:op.status,targetQuantity:dossier.quantity,
      processedQuantity:Number(row?.good??0)+Number(row?.scrap??0)+Number(row?.pending??0)+Number(row?.rework??0),dossierComplete:dossier.status==='COMPLETE',executionStatus:dossier.executionStatus,
      planned:op.planned||['RUNNING','DONE'].includes(op.status),machineBlocked:row?.machine_unavailable===true||statuses.includes(row?.machine_status??''),
      preparationMissing:coverage.needs.some(n=>!n.id||!n.operationId||!n.reviewed)||coverage.previousNeeds.length>0,
       programRequired:row?.program_required===true,programReady:row?.program_ready===true,qualityBlocked:!row||row.quality_blocked,inspectionMissing:row?.inspection_missing===true,
      componentsMissing:row?.kind==='ASSEMBLAGE'&&componentMissing,materials:materialFacts.get(op.id)??[],
      wholeOfMaterialBlockers:[...missingMaterial.map(n=>`${n.designation} : ${n.missing} ${n.unit??''} à couvrir physiquement.${n.blockers.length?' '+n.blockers.join(' '):''}`),...(originBlock?[originBlock]:[])],
      predecessors:dependencies.filter(d=>d.successor===op.id).map(d=>{
        const packages=external.filter(p=>p.operationId===d.predecessor);
        if(operations.some(source=>source.id===d.predecessor&&source.kind==='SOUS_TRAITANCE')){
          const good=packages.reduce((n,p)=>n+p.released,0);
          return {id:d.predecessor,label:d.label,done:good>=dossier.quantity,good,
            transferred:externalTransfers.filter(b=>b.operation_id===d.predecessor&&b.successor_operation_id===op.id).reduce((n,b)=>n+b.effective,0),
            partial:d.minimum!==null,minimum:d.minimum??1,requireTransfer:true};
        }
        return {id:d.predecessor,label:d.label,done:d.status==='DONE',good:d.good,transferred:Math.min(d.good,d.transferred),partial:d.partial,minimum:d.minimum??1};
      })};
    const firstMachining=operations.find(o=>['TOURNAGE','FRAISAGE','REPRISE'].includes(o.kind??''));
    const quantityKind=row?.kind==='DECOUPE'&&firstMachining?.kind==='TOURNAGE'&&coverage.needs.some(n=>n.operationId===op.id&&n.debitRule?.form==='BAR')?'POTENTIAL' as const:'ACTUAL' as const;
    return {...evaluateOperationReadiness(facts),machineId:row?.machine_id??null,materialOperation:facts.materials.length>0,quantityKind,
      successors:dependencies.filter(d=>d.predecessor===op.id).flatMap(d=>{const next=dossier.operations.find(o=>o.id===d.successor);return next?[{id:next.id,label:next.label,minimum:d.minimum??1}]:[]})};
  });
  return {enabled:true as const,ofId,number:dossier.number,missingMaterial,originPolicy:coverage.originPolicy,version:materialPropertiesFingerprint({coverage:coverage.version,operations,dependencies,external,componentCoverageVersion:componentCoverage?.version??null,materialAvailability:[...availableReservations].map(([key,a])=>[key,a.usable,a.blockers]),results}),operations:results};
}

export async function getOperationReadiness(ofId:number){
  const tx=await pool.connect();
  try{await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await usesOperationReadiness(tx,ofId)?await readOperationReadinessTx(tx,ofId):{enabled:false as const};await tx.query('COMMIT');return result;}
  catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}

/** Called before OF/pointage locks. The canonical gate rechecks quality under
 * lot locks so a concurrent quarantine cannot race a successful start. */
export async function assertMaterialOperationStartTx(tx:PoolClient,ofId:number,operationId:string|null|undefined,expectedVersion?:string,machineId?:string|null,acknowledgedWarnings?:string[]){
  if(!await usesOperationReadiness(tx,ofId))return null;
  await tx.query('SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE');
  await tx.query('SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE',[ofId]);
  if(!operationId)throw new HttpError(409,'OPERATION_REQUIRED','Choisissez l’opération à démarrer dans le dossier OF.');
  const reservations=(await tx.query<{lot_id:string}>(`SELECT DISTINCT r.lot_id::text FROM public.stock_reservations r
    LEFT JOIN public.v_of_material_need_destinations destination ON destination.source_need_id=r.material_need_id
    LEFT JOIN public.of_material_needs n ON n.id=destination.target_need_id
    LEFT JOIN public.of_component_requirements c ON c.id=r.of_component_requirement_id
    WHERE r.status='ACTIVE' AND r.lot_id IS NOT NULL AND(r.expires_at IS NULL OR r.expires_at>now()) AND
      ((n.of_id=$1) OR(r.of_id=$1 AND r.material_need_id IS NULL AND r.of_component_requirement_id IS NULL
        AND EXISTS(SELECT 1 FROM public.articles_matiere a WHERE a.article_id=r.article_id))
        OR(c.consuming_of_id=$1 AND EXISTS(SELECT 1 FROM public.of_operations op
        JOIN public.ordres_fabrication o ON o.id=op.of_id CROSS JOIN LATERAL jsonb_array_elements(o.technical_snapshot->'operations') f
        WHERE op.id=$2::uuid AND f->>'phase'=op.phase::text AND f->>'type_operation'='ASSEMBLAGE'))) ORDER BY 1`,[ofId,operationId])).rows;
  for(const r of reservations)await assertOperationalLotQualityEligibility({client:tx,lotId:r.lot_id,qty:0,purpose:'RESERVE'});
  if(await subcontractFlowInstalled(tx)){
    const externalLots=(await tx.query<{id:string}>(`SELECT DISTINCT e.lot_id::text AS id
      FROM public.subcontract_work_package_ledger e JOIN public.subcontract_work_packages p ON p.id=e.package_id
      JOIN public.of_operations op ON op.id=p.of_operation_id WHERE op.of_id=$1 AND e.event_type='RETURN' ORDER BY 1`,[ofId])).rows;
    for(const lot of externalLots)await tx.query('SELECT id FROM public.lots WHERE id=$1::uuid FOR UPDATE',[lot.id]);
  }
  const current=await readOperationReadinessTx(tx,ofId);
  if(expectedVersion&&expectedVersion!==current.version)throw new HttpError(409,'OPERATION_READINESS_CHANGED','La matière, le programme ou le planning a changé. Relisez les disponibilités avant de démarrer.');
  const operation=current.operations.find(o=>o.id===operationId);
  if(!operation)throw new HttpError(404,'OF_OPERATION_NOT_FOUND','Opération introuvable dans cet OF.');
  if(machineId&&machineId!==operation.machineId)throw new HttpError(409,'OPERATION_RESOURCE_CHANGED','Cette machine ne correspond pas à l’affectation de l’opération. Faites valider sa réaffectation dans le planning.');
  if(!operation.canStart)throw new HttpError(409,'OPERATION_NOT_READY','Cette opération ne peut pas encore démarrer.',{operation});
  if(acknowledgedWarnings!==undefined && operation.warnings.some(w=>!acknowledgedWarnings.includes(w.code)))
    throw new HttpError(409,'OPERATION_WARNINGS_REQUIRED','Prenez connaissance des alertes de passage partiel avant de démarrer.',{operation});
  return {version:current.version,operation,acknowledgedWarnings:acknowledgedWarnings??[]};
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
    return perBlank>0?Math.floor((n.consumed-(n.consumptionAdjustment??0))/perBlank+1e-9)-operation.processedQuantity:0;
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
