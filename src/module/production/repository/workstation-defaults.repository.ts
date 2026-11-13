import type { PoolClient } from "pg";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { PROGRAMMING_ASSIGNEE_PREDICATE_SQL } from "./programming-assignee.sql";
import { isWorkstationType, resolveDefaultPoste, workstationDefaultsSchema, WORKSTATION_SETTING, WORKSTATION_TYPES, WORKSTATION_LABELS, type Workstation, type WorkstationDefaults } from "../domain/workstation-defaults";

type Query = Pick<PoolClient, "query">;
type ResourceOperation = {id:string;designation:string;phase?:number|null;type_operation?:string|null;machine_id?:string|null;poste_id?:string|null;machine_family_code:string|null};
export async function prepareOperationResources(tx:Query, operations:readonly ResourceOperation[], ofId:number) {
  const setup=await readWorkstationDefaults(tx);
  const {rows:machines}=await tx.query<{id:string;name:string;family:string|null}>(`SELECT m.id::text,m.name,upper(btrim(m.machine_family_code)) AS family FROM public.machines m
    WHERE m.archived_at IS NULL AND m.status::text='ACTIVE' AND COALESCE((to_jsonb(m)->>'scheduling_enabled')::boolean,true)`);
  const {rows:assignments}=await tx.query<{source_id:string;phase:number;poste_id:string|null;machine_id:string|null}>(
    "SELECT source_piece_operation_id::text AS source_id,phase,poste_id::text,machine_id::text FROM public.of_operations WHERE of_id=$1 AND status::text<>'CANCELLED'",[ofId]);
  return operations.map(operation=>{
    const assigned=assignments.find(row=>row.source_id===operation.id || (operation.phase!=null&&row.phase===operation.phase));
    const posteId=assigned?.poste_id??operation.poste_id;
    const machineId=assigned?.machine_id??operation.machine_id;
    if(operation.type_operation==='SOUS_TRAITANCE')return {operation_id:operation.id,phase:operation.phase??null,label:operation.designation,resource:'Fournisseur de la prestation',source:'EXTERNAL',issue:null};
    const manual=isWorkstationType(operation.type_operation);
    const poste=posteId?setup.postes.find(row=>row.id===posteId&&row.is_active&&!row.archived_at):null;
    if(poste && ((manual&&!poste.machine_id) || machines.some(machine=>machine.id===poste.machine_id&&!!operation.machine_family_code&&machine.family===operation.machine_family_code.trim().toUpperCase())))return {operation_id:operation.id,phase:operation.phase??null,label:operation.designation,resource:poste.label,source:'ASSIGNED',issue:null};
    if(machineId){
      const machine=machines.find(row=>row.id===machineId);
      const qualified=machine&&(!operation.machine_family_code||machine.family===operation.machine_family_code.trim().toUpperCase());
      return {operation_id:operation.id,phase:operation.phase??null,label:operation.designation,resource:machine?.name??null,source:'ASSIGNED',
        issue:!machine?'La machine affectée est inactive, archivée ou retirée du planning.':!qualified?'La machine affectée ne correspond pas à la famille de cette opération.':null};
    }
    if(manual&&!posteId){const usual=resolveDefaultPoste(operation.type_operation as keyof typeof WORKSTATION_LABELS,setup.defaults,setup.postes);if(usual)return {operation_id:operation.id,phase:operation.phase??null,label:operation.designation,resource:usual.label,source:'DEFAULT',issue:null};}
    const eligible=machines.filter(machine=>!!operation.machine_family_code&&machine.family===operation.machine_family_code.trim().toUpperCase());
    return {operation_id:operation.id,phase:operation.phase??null,label:operation.designation,resource:eligible.length?`Famille ${operation.machine_family_code} · ${eligible.length} machine(s)`:null,source:'FAMILY',
      issue:posteId?'Le poste affecté est inactif, archivé ou incompatible avec cette opération.':eligible.length?null:manual?`Aucun poste de travail configuré pour ${WORKSTATION_LABELS[operation.type_operation as keyof typeof WORKSTATION_LABELS]}.`:'Aucune machine active qualifiée pour la famille de cette opération.'};
  });
}

/** Only fills newly generated operations; technical snapshots remain immutable. */
export async function assignGeneratedWorkstationDefaults(tx:Query,ofId:number) {
  const setup=await readWorkstationDefaults(tx);
  const defaults=Object.fromEntries(WORKSTATION_TYPES.map(type=>[type,resolveDefaultPoste(type,setup.defaults,setup.postes)?.id??null]));
  await tx.query(`UPDATE public.of_operations op SET poste_id=p.id
    FROM public.pieces_techniques_operations source,public.postes p
    WHERE op.of_id=$1 AND op.source_piece_operation_id=source.id AND op.machine_id IS NULL AND op.poste_id IS NULL
      AND p.id=($2::jsonb->>source.type_operation::text)::uuid AND p.is_active AND p.archived_at IS NULL AND p.machine_id IS NULL`,[ofId,JSON.stringify(defaults)]);
}
export async function readWorkstationDefaults(tx: Query = pool) {
  const { rows } = await tx.query<{value_json: unknown; updated_at: string}>(
    "SELECT value_json,updated_at::text FROM public.erp_settings WHERE key=$1", [WORKSTATION_SETTING]);
  const parsed = workstationDefaultsSchema.safeParse(rows[0]?.value_json);
  if(rows[0]&&!parsed.success)throw new HttpError(409,'WORKSTATION_CONFIGURATION_INVALID','Paramétrage des postes invalide : ouvrez le configurateur ERP.');
  const defaults: WorkstationDefaults = parsed.success ? parsed.data : { postes: {}, programmer_user_ids: [] };
  const { rows: postes } = await tx.query<Workstation>("SELECT id::text,code,label,machine_id::text,is_active,archived_at::text FROM public.postes ORDER BY label,id");
  return { defaults, postes, expected_updated_at: rows[0]?.updated_at ?? null };
}

export async function readWorkstationSetup(tx: Query = pool) {
  const result = await readWorkstationDefaults(tx);
  const { rows: programmers } = await tx.query<{id:number;name:string}>(
    `SELECT u.id,COALESCE(NULLIF(trim(concat_ws(' ',u.name,u.surname)),''),u.username) AS name
     FROM public.users u WHERE ${PROGRAMMING_ASSIGNEE_PREDICATE_SQL} ORDER BY name,u.id LIMIT 200`);
  const postes = Object.fromEntries(WORKSTATION_TYPES.map(type => [type, resolveDefaultPoste(type, result.defaults, result.postes)?.id ?? null]));
  const issues = (["DECOUPE", "CONTROLE", "EMBALLAGE"] as const).flatMap(type => postes[type] ? [] : [{code:"WORKSTATION_NOT_CONFIGURED", operation_type:type,
    message:`Aucun poste de travail configuré pour ${WORKSTATION_LABELS[type]}.`, action_path:"/administration/erp-settings?setup=machines&view=postes"}]);
  return { defaults:result.defaults,expected_updated_at:result.expected_updated_at,available_postes:result.postes, postes, programmers, programmer_user_ids: result.defaults.programmer_user_ids, issues };
}

export async function saveWorkstationSetup(input: WorkstationDefaults & {expected_updated_at: string | null}, userId: number) {
  return withRealtimeOutboxTransaction(await pool.connect(), async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [WORKSTATION_SETTING]);
    const current = await readWorkstationDefaults(tx);
    if (current.expected_updated_at !== input.expected_updated_at)
      throw new HttpError(409,"WORKSTATION_CONFIGURATION_CHANGED","Les postes habituels ont changé. Actualisez les réglages avant d’enregistrer.");
    for (const [type,id] of Object.entries(input.postes)) {
      if (!id) continue;
      if (!current.postes.some(poste => poste.id === id && poste.is_active && !poste.archived_at && !poste.machine_id))
        throw new HttpError(422,"WORKSTATION_INVALID",`Choisissez un poste autonome actif pour ${WORKSTATION_LABELS[type as keyof typeof WORKSTATION_LABELS]}.`);
    }
    if (input.programmer_user_ids.length) {
      const {rows} = await tx.query(`SELECT u.id FROM public.users u WHERE u.id=ANY($1::int[]) AND ${PROGRAMMING_ASSIGNEE_PREDICATE_SQL} FOR SHARE OF u`,[input.programmer_user_ids]);
      if (rows.length !== input.programmer_user_ids.length) throw new HttpError(422,"PROGRAMMER_REQUIRED","Choisissez uniquement des programmeurs actifs et habilités.");
    }
    const value = {postes:input.postes,programmer_user_ids:input.programmer_user_ids};
    await tx.query(`INSERT INTO public.erp_settings(key,value_json,created_by,updated_by) VALUES($1,$2::jsonb,$3,$3)
      ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[WORKSTATION_SETTING,JSON.stringify(value),userId]);
    await tx.query("UPDATE public.planning_central_settings SET revision=revision+1,updated_at=clock_timestamp() WHERE singleton");
    await repoInsertAuditLog({user_id:userId,body:{event_type:"ACTION",action:"ERP_WORKSTATION_DEFAULTS_SAVED",page_key:"erp-settings",entity_type:"erp_setting",entity_id:WORKSTATION_SETTING,
      path:"/api/v1/admin/onboarding/workstations",details:{operation_types:Object.keys(input.postes),programmer_count:input.programmer_user_ids.length}},ip:null,user_agent:null,device_type:null,os:null,browser:null,tx});
    return readWorkstationSetup(tx);
  });
}
