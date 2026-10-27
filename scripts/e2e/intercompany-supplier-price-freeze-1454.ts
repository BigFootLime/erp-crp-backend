import { Pool } from "pg";
import { resolveSupplierPurchaseTx } from "../../src/module/entreprises/intercompany/supplier-purchase.adapter";

const url=process.env.DATABASE_URL; if(!url)throw new Error("DATABASE_URL_REQUIRED");
async function main(){const pool=new Pool({connectionString:url});const tx=await pool.connect();try{
  await tx.query("BEGIN");
  const message=(await tx.query<{payload:unknown;source_company_id:string;destination_company_id:string;environment:"cerp_test"}>("SELECT payload,source_company_id::text,destination_company_id::text,environment FROM cerp_intercompany_inbox WHERE kind='PURCHASE_SUBMITTED' ORDER BY received_at DESC LIMIT 1 FOR SHARE")).rows[0];
  if(!message)throw new Error("PURCHASE_SUBMITTED_FIXTURE_MISSING");
  const payload=message.payload as {relation_id:string;lines:Array<{supplier_catalogue_mapping_id:string;supplier_mapping_version:number}>}; const line=payload.lines[0]; if(!line)throw new Error("PURCHASE_LINE_MISSING");
  await tx.query("UPDATE intercompany_commercial_catalogue SET supplier_sale_unit_price=supplier_sale_unit_price+999,version=version+1 WHERE id=$1::uuid",[line.supplier_catalogue_mapping_id]);
  const resolved=await resolveSupplierPurchaseTx(tx,payload,{source_company_id:message.source_company_id,destination_company_id:message.destination_company_id,environment:message.environment});
  if(resolved.lignes[0]?.prix_unitaire_ht!==70)throw new Error(`PRICE_FREEZE_FAILED:${resolved.lignes[0]?.prix_unitaire_ht}`);
  const stale=structuredClone(payload); stale.lines[0].supplier_mapping_version+=999;
  let rejected=false;try{await resolveSupplierPurchaseTx(tx,stale,{source_company_id:message.source_company_id,destination_company_id:message.destination_company_id,environment:message.environment});}catch(error){rejected=(error as {code?:string}).code==='INTERCOMPANY_PURCHASE_BINDING_STALE'}
  if(!rejected)throw new Error("STALE_REVISION_NOT_REJECTED");
  console.log(JSON.stringify({result:"SUPPLIER_PRICE_FREEZE_OK",published_price:70,current_offer_changed:true,stale_revision_rejected:true}));
}finally{await tx.query("ROLLBACK").catch(()=>{});tx.release();await pool.end();}}
main().catch(error=>{console.error(error instanceof Error?error.stack:error);process.exitCode=1});
