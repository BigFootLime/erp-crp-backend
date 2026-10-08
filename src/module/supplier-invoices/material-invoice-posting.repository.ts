import { createHash,randomUUID } from 'node:crypto';
import pool from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { repoInsertAuditLog } from '../audit-logs/repository/audit-logs.repository';
import type { MarginAuditContext } from '../margin-engine/repository/margin-engine.repository';
import type { CumpState } from '../stock/domain/cump-valuation';
import { CUMP_STORE_BALANCE_SQL } from '../stock/repository/cump-projection.sql';
import { buildMaterialInvoicePosting } from './material-invoice-posting';
import { proposeMaterialInvoiceReconciliation } from './material-invoice-reconciliation';
import { materialInvoiceQueries,readMaterialInvoiceSourcesTx,publicMaterialInvoicePosting,type MaterialPostingHistoryRow } from './material-invoice-reconciliation.repository';
import type { MaterialInvoicePostingInput } from './material-invoice-posting.validators';
import * as sql from './material-invoice-posting.sql';

/** Explicit Finance intent. No HTTP price, automatic approval or historic rewrite. */
export async function repoConfirmMaterialInvoice(invoiceId:string,input:MaterialInvoicePostingInput,audit:MarginAuditContext) {
  const requestHash=createHash('sha256').update(JSON.stringify({invoice_id:invoiceId,...input,actor_id:audit.user_id})).digest('hex');
  const tx=await pool.connect(),query=materialInvoiceQueries(tx,Date.now()+10000);
  try {
    await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='500ms'");
    await query(sql.MATERIAL_POSTING_REQUEST_LOCK_SQL,[input.request_id]);
    const replay=(await query<MaterialPostingHistoryRow>(sql.MATERIAL_POSTING_REPLAY_SQL,[input.request_id]))[0];
    if(replay) {
      if(replay.request_hash!==requestHash)throw new HttpError(409,'MATERIAL_RECONCILIATION_INTENT_CONFLICT','Cette demande correspond à une autre validation.');
      const reconciliation=publicMaterialInvoicePosting(replay);await query('COMMIT');return {reconciliation,replayed:true};
    }
    await query(sql.MATERIAL_POSTING_PROJECTOR_LOCK_SQL);
    const control=(await query<{mode:string;initialized:boolean;reporting_currency:string;formula_version:string;last_sequence:string}>(sql.MATERIAL_POSTING_CONTROL_SQL))[0];
    if(!control||control.mode!=='ACTIVE'||!control.initialized||control.reporting_currency!=='EUR'||control.formula_version!=='CERP-CUMP-1.0.0')
      throw new HttpError(409,'MATERIAL_RECONCILIATION_NOT_ACTIVE','La valorisation doit être activée et rapprochée avant cette validation.');
    await query('LOCK TABLE public.stock_valuation_movement_journal IN SHARE MODE');
    if(!(await query(sql.MATERIAL_POSTING_INVOICE_LOCK_SQL,[invoiceId]))[0])throw new HttpError(404,'SUPPLIER_INVOICE_NOT_FOUND','Facture introuvable.');
    await query(sql.MATERIAL_POSTING_FISCAL_BARRIER_SQL);
    if((await query(sql.MATERIAL_POSTING_HISTORY_SQL,[invoiceId]))[0])
      throw new HttpError(409,'MATERIAL_RECONCILIATION_ALREADY_APPLIED','Cette facture a déjà été appliquée. Consultez son rapprochement.');
    const source=await readMaterialInvoiceSourcesTx(query,invoiceId),proposal=proposeMaterialInvoiceReconciliation(source);
    if(proposal.source_sha256!==input.expected_source_sha256||!proposal.calculable||!proposal.projection_ready)
      throw new HttpError(409,'MATERIAL_RECONCILIATION_SOURCE_CHANGED','Actualisez et vérifiez le rapprochement matière proposé.');
    const states=source.balances.map(b=>({state:(b.source_snapshot as {before_state:CumpState}).before_state,entry_id:randomUUID()}));
    let posting:ReturnType<typeof buildMaterialInvoicePosting>;
    try {posting=buildMaterialInvoicePosting(proposal.lines,states);}catch {
      throw new HttpError(409,'MATERIAL_RECONCILIATION_VALUE_UNRESOLVED','La valeur restante ou l’attribution consommée doit être vérifiée.');
    }
    const id=randomUUID(),response={id,invoice_id:invoiceId,source_sha256:proposal.source_sha256,method:input.method,
      currency:'EUR',source_reliability:'DECLARED',posting};
    const snapshot={schema_version:1,source,proposal,posting,approval:{created_by:audit.user_id},response};
    if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>8*1024*1024)
      throw new HttpError(409,'MATERIAL_RECONCILIATION_TOO_DENSE','Le dossier matière est trop volumineux pour cette validation.');
    const parent=(await query<{id:string;source_sha256:string}>(sql.MATERIAL_POSTING_INSERT_SQL,
      [id,invoiceId,input.request_id,requestHash,proposal.source_sha256,JSON.stringify(snapshot),audit.user_id]))[0];
    if(!parent)throw Error('MATERIAL_RECONCILIATION_NOT_STORED');
    for(const item of posting.adjustments) {
      const candidate=source.balances.find(b=>b.article_id===item.article_id&&b.unit===item.unit)!.source_snapshot as {previous_entry_id:string};
      const result=item.result;
      await query(sql.MATERIAL_POSTING_SCOPE_SQL,[item.entry_id,id,item.article_id,item.unit,candidate.previous_entry_id,result.before.quantity,
        result.before.value,item.stock_variance_ht,item.consumed_variance_ht,result.after.value]);
      const proof={schema_version:1,invoice_reconciliation_id:id,invoice_reconciliation_sha256:parent.source_sha256,
        previous_entry_id:candidate.previous_entry_id,before_state:result.before,after_state:result.after,result};
      await query(sql.MATERIAL_POSTING_ENTRY_SQL,[item.entry_id,item.article_id,item.unit,control.last_sequence,
        result.valueDelta,result.movementValue,JSON.stringify(proof),id]);
      await query(CUMP_STORE_BALANCE_SQL,[item.article_id,'COMPANY',item.unit,'EUR',result.after.quantity,result.after.value,
        'DECLARED',result.after.sourceRef,control.last_sequence,item.entry_id]);
    }
    await query(sql.MATERIAL_POSTING_CONSUMPTION_SQL,[id,JSON.stringify(posting.consumption)]);
    await repoInsertAuditLog({user_id:audit.user_id,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,
      os:audit.os,browser:audit.browser,tx,body:{event_type:'ACTION',action:'MATERIAL_INVOICE_VARIANCE_CONFIRMED',page_key:'supplier-invoices',
        entity_type:'stock_invoice_reconciliation',entity_id:id,path:audit.path,client_session_id:audit.client_session_id,
        details:{invoice_id:invoiceId,method:input.method,source_sha256:proposal.source_sha256,posting_sha256:parent.source_sha256,
          scope_count:posting.adjustments.length,consumption_count:posting.consumption.length,source_reliability:'DECLARED'}}});
    await query('COMMIT');return {reconciliation:response,replayed:false};
  } catch(error) {
    await tx.query('ROLLBACK');
    if(error&&typeof error==='object'&&'code' in error&&['55P03','57014','40001','40P01','23505','23514','23503','22003'].includes(String(error.code)))
      throw new HttpError(409,'MATERIAL_RECONCILIATION_BUSY','Les sources ou le stock ont changé. Actualisez ou reprenez la même validation.');
    throw error;
  } finally {tx.release();}
}
