import type {PoolClient} from 'pg';
import pool from '../../../config/database';
import {withRealtimeOutboxTransaction} from '../../../shared/realtime/realtime-outbox-transaction';
import {repoInsertAuditLog} from '../../audit-logs/repository/audit-logs.repository';

export const SUPPLIER_QUALITY_SETTING='purchases.supplier_quality';
type Queryer=Pick<PoolClient,'query'>;

// The original atelier production and test sites belong to Croix Rousse.
// Dedicated company instances have their own Directory site identifiers.
export function supplierQualityDefault(site=process.env.CERP_SHARED_DIRECTORY_SITE){
  return site!=='cerp_prod'&&site!=='cerp_test';
}

export async function readSupplierQualitySetting(tx:Queryer=pool,lock=false){
  const row=(await tx.query<{value_json:{enabled?:boolean}|null;updated_at:string}>(
    'SELECT value_json,updated_at::text FROM public.erp_settings WHERE key=$1'+(lock?' FOR SHARE':''),
    [SUPPLIER_QUALITY_SETTING],
  )).rows[0];
  return {key:SUPPLIER_QUALITY_SETTING,value_json:{enabled:row?.value_json?.enabled??supplierQualityDefault()},value_text:null,updated_at:row?.updated_at??null};
}

export async function saveSupplierQualitySetting(enabled:boolean,actor:number){
  return withRealtimeOutboxTransaction(await pool.connect(),async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[SUPPLIER_QUALITY_SETTING]);
    const previous=await readSupplierQualitySetting(tx,true);
    if(previous.updated_at&&previous.value_json.enabled===enabled)return previous;
    const result=await tx.query<{updated_at:string}>(`INSERT INTO public.erp_settings(key,value_json,created_by,updated_by)
      VALUES($1,$2::jsonb,$3,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,value_text=NULL,
      updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING updated_at::text`,
    [SUPPLIER_QUALITY_SETTING,JSON.stringify({enabled}),actor]);
    await repoInsertAuditLog({user_id:actor,body:{event_type:'ACTION',action:'ADMIN_ERP_SETTING_UPDATED',page_key:'erp-settings',
      entity_type:'erp_setting',entity_id:SUPPLIER_QUALITY_SETTING,path:'/api/v1/admin/erp-settings/'+SUPPLIER_QUALITY_SETTING,
      details:{previous_enabled:previous.value_json.enabled,enabled}},ip:null,user_agent:null,device_type:null,os:null,browser:null,tx});
    return {...previous,value_json:{enabled},updated_at:result.rows[0].updated_at};
  });
}
