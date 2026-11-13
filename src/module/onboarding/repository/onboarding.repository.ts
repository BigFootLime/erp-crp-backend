import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type { SetupCompany } from "../validators/onboarding.validators";

export async function readCommercialSetupFacts(userId: number) {
 const { rows } = await pool.query(`SELECT
   (SELECT count(*)::int FROM public.auth_login_logs WHERE user_id=$1 AND success) AS login_count,
   (SELECT current_step FROM public.erp_setup_progress WHERE user_id=$1) AS current_step,
   (SELECT value_text FROM public.erp_settings WHERE key='company.primary_biller_id') AS primary_biller_id,
   EXISTS(SELECT 1 FROM public.erp_settings s JOIN public.factureur f ON f.biller_id::text=s.value_text WHERE s.key='company.primary_biller_id'
    AND length(btrim(f.biller_name))>1 AND length(btrim(f.street))>0 AND length(btrim(f.city))>0
    AND length(btrim(f.postal_code))>0 AND length(btrim(f.country))>0 AND length(btrim(f.email))>0) AS company_ready`, [userId]);
 return rows[0];
}

export const readSetupFacts=async (userId:number) => {
 const {rows}=await pool.query(`WITH today AS (SELECT (now() AT TIME ZONE 'Europe/Paris')::date AS d), fleet AS (
   SELECT m.id,m.name,m.code,m.cf_id,
    (m.machine_family_code IS NOT NULL AND m.cf_id IS NOT NULL AND cf.statut='ACTIF'
     AND family.actif AND m.valid_from IS NOT NULL AND m.valid_from<=today.d AND (m.valid_to IS NULL OR m.valid_to>=today.d)) AS qualified,
    EXISTS(SELECT 1 FROM public.production_cost_center_rates r WHERE r.cf_id=m.cf_id AND r.taux_horaire>0
      AND r.date_effet<=today.d AND (r.date_fin IS NULL OR r.date_fin>=today.d)) AS rate_ready,
    EXISTS(SELECT 1 FROM public.production_maintenance_schedules s JOIN public.production_maintenance_schedule_revisions r ON r.schedule_id=s.id AND r.version=s.version
      WHERE s.enabled AND s.kind='LEVEL_1_WEEKLY' AND (r.definition->>'duration_minutes')::int=60 AND (r.definition->>'end_date')::date>=today.d
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'targets') t WHERE t->>'machine_id'=m.id::text)) AS weekly_ready,
    EXISTS(SELECT 1 FROM public.production_maintenance_schedules s JOIN public.production_maintenance_schedule_revisions r ON r.schedule_id=s.id AND r.version=s.version
      WHERE s.enabled AND s.kind='LEVEL_2_ANNUAL' AND (r.definition->>'duration_days')::int=1 AND (r.definition->>'year')::int=extract(year FROM today.d)
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.definition->'entries') t WHERE t->>'machine_id'=m.id::text)) AS annual_ready
   FROM public.machines m CROSS JOIN today LEFT JOIN public.centres_frais cf ON cf.id=m.cf_id
    LEFT JOIN public.production_machine_families family ON family.code=m.machine_family_code
   WHERE m.status='ACTIVE' AND m.scheduling_enabled
 ) SELECT
  (SELECT count(*)::int FROM public.auth_login_logs WHERE user_id=$1 AND success) AS login_count,
  (SELECT current_step FROM public.erp_setup_progress WHERE user_id=$1) AS current_step,
  (SELECT value_text FROM public.erp_settings WHERE key='company.primary_biller_id') AS primary_biller_id,
  (SELECT count(*)::int FROM fleet) AS machine_count,
  (SELECT count(*)::int FROM fleet WHERE qualified) AS qualified_count,
  (SELECT count(*)::int FROM fleet WHERE rate_ready) AS rated_count,
  (SELECT count(*)::int FROM fleet WHERE weekly_ready AND annual_ready) AS maintained_count,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',COALESCE(name,code),'qualified',COALESCE(qualified,false),'rate_ready',rate_ready,'weekly_ready',weekly_ready,'annual_ready',annual_ready) ORDER BY name) FROM fleet),'[]'::jsonb) AS machines,
  EXISTS(SELECT 1 FROM public.planning_central_settings s JOIN public.programmation_calendars c ON c.id=s.workshop_calendar_id
    WHERE s.singleton AND c.active AND cardinality(c.working_days)>0 AND c.day_start<c.day_end) AS workshop_ready,
  EXISTS(SELECT 1 FROM public.centres_frais cf JOIN public.production_cost_center_rates r ON r.cf_id=cf.id CROSS JOIN today
    WHERE cf.statut='ACTIF' AND r.taux_horaire>0 AND r.date_effet<=today.d AND (r.date_fin IS NULL OR r.date_fin>=today.d)) AS costs_ready,
  EXISTS(SELECT 1 FROM public.hr_employees e JOIN public.hr_employment_contracts c ON c.employee_id=e.id CROSS JOIN today
    WHERE e.user_id=$1 AND e.status='ACTIVE' AND c.active AND c.start_date<=today.d AND (c.end_date IS NULL OR c.end_date>=today.d)
     AND c.weekly_hours_target>0 AND c.daily_hours_target>0
     AND EXISTS(SELECT 1 FROM public.hr_work_schedules h WHERE h.employee_id=e.id AND h.active AND h.expected_start<h.expected_end)) AS hours_ready,
  EXISTS(SELECT 1 FROM public.erp_settings s JOIN public.emplacements e ON e.id::text=s.value_json->>'emplacement_id'
    JOIN public.magasins m ON m.id=e.magasin_id WHERE s.key='stock.default_shipping_location' AND m.id::text=s.value_json->>'magasin_id'
     AND e.is_active AND m.is_active AND NOT e.is_scrap) AS stock_ready,
  EXISTS(SELECT 1 FROM public.erp_settings s JOIN public.factureur f ON f.biller_id::text=s.value_text WHERE s.key='company.primary_biller_id'
    AND length(btrim(f.biller_name))>1 AND length(btrim(f.street))>0 AND length(btrim(f.city))>0
    AND length(btrim(f.postal_code))>0 AND length(btrim(f.country))>0 AND length(btrim(f.email))>0) AS company_ready`,[userId]);
 return rows[0];
};
export async function saveSetupStep(userId:number,currentStep:string) {
 await pool.query(`INSERT INTO public.erp_setup_progress(user_id,current_step) VALUES($1,$2)
  ON CONFLICT(user_id) DO UPDATE SET current_step=EXCLUDED.current_step,updated_at=now()`,[userId,currentStep]);
}
export async function readSetupCompanies() {
 const {rows}=await pool.query(`SELECT f.biller_id,f.biller_name,f.street,f.house_number,f.postal_code,f.city,f.country,f.phone,f.email,
   m.legal_form,m.siret,m.vat_number,m.share_capital,m.rcs_city,m.rcs_number,
   m.late_penalty_rate,m.recovery_indemnity,m.effective_from::text AS effective_from,
   f.modification_date::text AS expected_updated_at,
   EXISTS(SELECT 1 FROM public.erp_settings s WHERE s.key='company.primary_biller_id' AND s.value_text=f.biller_id::text) AS selected
  FROM public.factureur f LEFT JOIN LATERAL(SELECT * FROM public.finance_legal_mentions l WHERE l.biller_id=f.biller_id AND l.effective_to IS NULL ORDER BY l.version DESC LIMIT 1) m ON true
  ORDER BY f.biller_name`);
 return rows;
}
const legalKeys=["legal_form","siret","vat_number","share_capital","rcs_city","rcs_number","late_penalty_rate","recovery_indemnity"] as const;
async function auditCompany(tx:PoolClient,userId:number,billerId:string) {
 await repoInsertAuditLog({user_id:userId,body:{event_type:"ACTION",action:"ERP_SETUP_COMPANY_SAVED",page_key:"erp-settings",entity_type:"biller",entity_id:billerId,
  path:"/api/v1/admin/onboarding/company",details:{canonical_biller:true,legal_mentions_versioned:true}},ip:null,user_agent:null,device_type:null,os:null,browser:null,tx});
}
export async function saveSetupCompany(input:SetupCompany,userId:number,key:string) {
 const requestHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const client=await pool.connect();
 return withRealtimeOutboxTransaction(client,async tx=> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('erp:setup:company',0))");
  const replay=await tx.query<{request_hash:string;actor_id:number;biller_id:string}>("SELECT request_hash,actor_id,biller_id FROM public.erp_setup_company_commands WHERE idempotency_key=$1::uuid",[key]);
  if(replay.rows[0]) {
   if(replay.rows[0].request_hash!==requestHash || replay.rows[0].actor_id!==userId) throw new HttpError(409,'COMPANY_KEY_REUSED','Cette demande concerne une autre saisie.');
   return {biller_id:replay.rows[0].biller_id,key,requestHash};
  }
  let id=input.biller_id;
  if(id) {
   const current=await tx.query<{updated_at:string}>("SELECT modification_date::text AS updated_at FROM public.factureur WHERE biller_id=$1::uuid FOR UPDATE",[id]);
   if(!current.rows[0] || current.rows[0].updated_at!==input.expected_updated_at) throw new HttpError(409,"COMPANY_CHANGED","L’entreprise a changé. Rechargez sa fiche avant d’enregistrer.");
  }
  const args=[input.biller_name,input.street,input.house_number,input.postal_code,input.city,input.country,input.phone,input.email];
  if(!id) {
   const result=await tx.query<{biller_id:string}>(`INSERT INTO public.factureur(biller_name,street,house_number,postal_code,city,country,phone,email,creation_date,modification_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),now()) RETURNING biller_id`,args); id=result.rows[0].biller_id;
  } else await tx.query(`UPDATE public.factureur SET biller_name=$1,street=$2,house_number=$3,postal_code=$4,city=$5,country=$6,phone=$7,email=$8,modification_date=now() WHERE biller_id=$9::uuid`,[...args,id]);
  const {rows}=await tx.query<Record<string,unknown>>("SELECT * FROM public.finance_legal_mentions WHERE biller_id=$1::uuid AND effective_to IS NULL FOR UPDATE",[id]);
  const previous=rows[0];
  const changed=!previous || legalKeys.some(k=>["share_capital","late_penalty_rate","recovery_indemnity"].includes(k)
   ? previous[k] == null || Number(previous[k])!==input[k] : String(previous[k] ?? "")!==String(input[k]));
  if(changed) {
   const today=await tx.query<{today:string}>("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS today");
   if(previous && (String(previous.effective_from instanceof Date ? previous.effective_from.toISOString().slice(0,10) : previous.effective_from)>=input.effective_from || input.effective_from<=today.rows[0].today))
    throw new HttpError(409,"LEGAL_MENTIONS_DATE_CONFLICT","Choisissez une date d’effet après la version légale actuelle. Son historique doit être conservé.");
   if(previous) await tx.query("UPDATE public.finance_legal_mentions SET effective_to=$2::date WHERE mention_set_id=$1",[previous.mention_set_id,input.effective_from]);
   // Preserve all legal fields not exposed by this initial form when creating the next version.
   await tx.query(`INSERT INTO public.finance_legal_mentions(biller_id,version,effective_from,legal_form,siret,siren,vat_number,share_capital,share_capital_currency,
    rcs_city,rcs_number,late_penalty_rate,late_penalty_basis,recovery_indemnity,created_by,
    ape_code,early_discount_rate,early_discount_basis,vat_on_receipts,vat_exempt_293b,retention_of_title,extra_mentions,
    electronic_address_scheme,electronic_address_value,electronic_address_directory_entry_id,electronic_address_verified_at)
    VALUES($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [id,Number(previous?.version ?? 0)+1,input.effective_from,input.legal_form,input.siret,input.siret.slice(0,9),input.vat_number || null,input.share_capital,previous?.share_capital_currency ?? "EUR",
     input.rcs_city || null,input.rcs_number || null,input.late_penalty_rate,previous?.late_penalty_basis ?? "ANNUEL",input.recovery_indemnity,userId,
     previous?.ape_code ?? null,previous?.early_discount_rate ?? null,previous?.early_discount_basis ?? null,previous?.vat_on_receipts ?? false,previous?.vat_exempt_293b ?? false,
     previous?.retention_of_title ?? null,previous?.extra_mentions ?? [],previous?.electronic_address_scheme ?? null,previous?.electronic_address_value ?? null,
     previous?.electronic_address_directory_entry_id ?? null,previous?.electronic_address_verified_at ?? null]);
  }
  await tx.query(`INSERT INTO public.erp_settings(key,value_text,created_by,updated_by) VALUES('company.primary_biller_id',$1,$2,$2)
    ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text,updated_by=EXCLUDED.updated_by,updated_at=now()`,[id,userId]);
  await auditCompany(tx,userId,id);
  await tx.query("INSERT INTO public.erp_setup_company_commands(idempotency_key,request_hash,actor_id,biller_id) VALUES($1::uuid,$2,$3,$4::uuid)",[key,requestHash,userId,id]);
  return {biller_id:id,key,requestHash};
 },{reconcileCommit:async(verifier,mutation)=>{
  const {rows}=await verifier.query<{biller_id:string;actor_id:number;request_hash:string}>("SELECT biller_id,actor_id,request_hash FROM public.erp_setup_company_commands WHERE idempotency_key=$1::uuid",[mutation.key]);
  return !rows[0] ? "not_committed" : rows[0].biller_id===mutation.biller_id && rows[0].actor_id===userId && rows[0].request_hash===mutation.requestHash ? "committed" : "unknown";
 }});
}
