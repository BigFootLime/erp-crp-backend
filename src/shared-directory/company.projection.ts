import {z} from 'zod';
import type {Pool} from 'pg';
import {directoryProfileSchema} from './model';
import {projectDirectoryProfile,sharedDirectoryClient} from './site-runtime';
const billerColumns=['biller_id','biller_name','street','house_number','postal_code','city','country','phone','email','default_bank_name','default_iban','default_bic','text_on_invoice','created_at','updated_at'] as const;
const mentionColumns=['mention_set_id','biller_id','version','effective_from','effective_to','legal_form','share_capital','share_capital_currency','rcs_city','rcs_number','siren','siret','vat_number','ape_code','late_penalty_rate','late_penalty_basis','recovery_indemnity','early_discount_rate','early_discount_basis','vat_on_receipts','vat_exempt_293b','retention_of_title','extra_mentions','created_at','created_by','electronic_address_scheme','electronic_address_value','electronic_address_directory_entry_id','electronic_address_verified_at'] as const;
const snapshotSchema=z.object({revision:z.number().int().nonnegative(),primary_biller_id:z.string().uuid().nullable(),billers:z.array(z.record(z.unknown())),mentions:z.array(z.record(z.unknown())),profiles:z.array(directoryProfileSchema)}).strict();
/** Add canonical UUIDs; never merge an existing legacy company by its name. */
export async function synchronizeDirectoryCompany(db:Pool,session:string){
 const client=sharedDirectoryClient();if(!client)return;
 const snapshot=snapshotSchema.parse(await client.call('company-snapshot',{directory_session:session,input:{}}));
 const localCreators=new Map<string,number>();for(const profile of snapshot.profiles)localCreators.set(profile.profile_id,(await projectDirectoryProfile(db,profile)).id);
 const tx=await db.connect();await tx.query('BEGIN');
 try{
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('directory:company:projection',0))");
  const state=(await tx.query('SELECT revision FROM public.cerp_directory_company_state WHERE singleton')).rows[0];
  if(state&&state.revision===snapshot.revision){await tx.query('COMMIT');return;}
  for(const biller of snapshot.billers){
   const id=z.string().uuid().parse(biller.biller_id),known=(await tx.query('SELECT 1 FROM public.cerp_directory_company_bindings WHERE biller_id=$1::uuid',[id])).rows.length>0;
   if(!known&&(await tx.query('SELECT 1 FROM public.factureur WHERE biller_id=$1::uuid',[id])).rows.length)throw new Error('DIRECTORY_COMPANY_UUID_COLLISION');
   const data=Object.fromEntries(billerColumns.map(column=>[column,biller[column]]));
   await tx.query(`INSERT INTO public.factureur(${billerColumns.join(',')}) SELECT ${billerColumns.join(',')} FROM jsonb_populate_record(NULL::public.factureur,$1::jsonb)
    ON CONFLICT(biller_id) DO UPDATE SET ${billerColumns.filter(c=>c!=='biller_id'&&c!=='created_at').map(c=>`${c}=excluded.${c}`).join(',')}`, [JSON.stringify(data)]);
   await tx.query('INSERT INTO public.cerp_directory_company_bindings(biller_id) VALUES($1::uuid) ON CONFLICT DO NOTHING',[id]);
  }
  for(const mention of snapshot.mentions){
   const id=z.string().uuid().parse(mention.mention_set_id),biller=z.string().uuid().parse(mention.biller_id);
   if(!snapshot.billers.some(b=>b.biller_id===biller))throw new Error('DIRECTORY_LEGAL_COMPANY_MISMATCH');
   const data=Object.fromEntries(mentionColumns.map(column=>[column,column==='created_by'?(typeof mention.creator_profile_id==='string'?localCreators.get(mention.creator_profile_id)??null:null):mention[column]]));
   const existing=(await tx.query<{data:Record<string,unknown>}>('SELECT to_jsonb(m) AS data FROM public.finance_legal_mentions m WHERE mention_set_id=$1::uuid',[id])).rows[0];
   if(existing){
    for(const column of mentionColumns.filter(c=>c!=='effective_to'))if(JSON.stringify(existing.data[column])!==JSON.stringify(data[column]))throw new Error('DIRECTORY_LEGAL_HISTORY_CHANGED');
    if(existing.data.effective_to!==data.effective_to){
     if(existing.data.effective_to!==null)throw new Error('DIRECTORY_LEGAL_HISTORY_CHANGED');
     await tx.query('UPDATE public.finance_legal_mentions SET effective_to=$2::date WHERE mention_set_id=$1::uuid',[id,data.effective_to]);
    }
   }else await tx.query(`INSERT INTO public.finance_legal_mentions(${mentionColumns.join(',')}) SELECT ${mentionColumns.join(',')} FROM jsonb_populate_record(NULL::public.finance_legal_mentions,$1::jsonb)`,[JSON.stringify(data)]);
  }
  if(snapshot.primary_biller_id){
   if(!snapshot.billers.some(b=>b.biller_id===snapshot.primary_biller_id))throw new Error('DIRECTORY_PRIMARY_COMPANY_UNKNOWN');
   await tx.query("INSERT INTO public.erp_settings(key,value_text) VALUES('company.primary_biller_id',$1) ON CONFLICT(key) DO UPDATE SET value_text=excluded.value_text,updated_at=now() WHERE public.erp_settings.value_text IS DISTINCT FROM excluded.value_text",[snapshot.primary_biller_id]);
  }else{
   // The agreed empty authority must not adopt a legacy default setting.
   await tx.query("DELETE FROM public.erp_settings WHERE key='company.primary_biller_id'");
  }
  await tx.query('INSERT INTO public.cerp_directory_company_state(singleton,revision) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,updated_at=now()',[snapshot.revision]);
  await tx.query('COMMIT');
 }catch(error){await tx.query('ROLLBACK');throw error;}finally{tx.release();}
}
