import { createHash,randomUUID } from 'node:crypto';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { MarginAuditContext } from '../../margin-engine/repository/margin-engine.repository';
import type { DeclareValueAdjustment } from '../validators/cump-value-adjustment.validators';
import { applyCumpValueAdjustment,CUMP_VALUE_ADJUSTMENT_FORMULA } from '../domain/cump-value-adjustment';
import type { CumpState } from '../domain/cump-valuation';
import { OPENING_BASIS_DOCUMENTS_SQL,OPENING_BASIS_DOCUMENT_LOCK_SQL } from './cump-opening-basis.sql';
import { CUMP_STORE_BALANCE_SQL } from './cump-projection.sql';
import * as sql from './cump-value-adjustment.sql';

type CandidateRow={source_snapshot:{eligible:boolean;quantity:string|null;before_state:CumpState|null;
  previous_entry_id:string|null;projector:{last_sequence:string;mode:string}};source_sha256:string};
type AdjustmentRow={id:string;entry_id:string;article_id:string;owner_key:string;stock_unit:string;currency:string;
  quantity:string;previous_value_ht:string|null;total_value_ht:string;value_delta:string|null;previous_entry_id:string;
  document_id:string;document_sha256:string;source_reliability:string;source_sha256:string;
  created_by:number;created_at:string;source_valid:boolean;request_hash?:string};
const missing=()=>new HttpError(404,'VALUE_ADJUSTMENT_ARTICLE_NOT_FOUND','Article introuvable.');
function publicAdjustment(row:AdjustmentRow) {
  if(!row.source_valid)throw new HttpError(409,'VALUE_ADJUSTMENT_PROOF_INVALID','La preuve de correction doit être vérifiée.');
  const {request_hash:_hash,...adjustment}=row;return adjustment;
}
export async function repoValueAdjustmentCandidate(articleId:string,unit:string) {
  const row=(await pool.query<CandidateRow>(sql.VALUE_ADJUSTMENT_CANDIDATE_SQL,[articleId,unit])).rows[0];
  if(!row)throw missing();
  if(!row.source_snapshot)throw new HttpError(409,'VALUE_ADJUSTMENT_CONTROL_MISSING','Préparation de la valorisation indisponible.');
  const documents=(await pool.query<{id:string;name:string;sha256:string}>(OPENING_BASIS_DOCUMENTS_SQL,[articleId])).rows;
  return {article_id:articleId,owner:'COMPANY',unit,currency:'EUR',source_reliability:'DECLARED',
    eligible:row.source_snapshot.eligible===true,quantity:row.source_snapshot.eligible?row.source_snapshot.quantity:null,
    current_value_ht:row.source_snapshot.eligible?row.source_snapshot.before_state?.value??null:null,
    source_sha256:row.source_sha256,documents:documents.slice(0,100),documents_truncated:documents.length>100,
    issues:row.source_snapshot.eligible?[]:[row.source_snapshot.projector.mode==='PREPARED'
      ?'CUMP_PROJECTION_NOT_ACTIVE':'VALUE_ADJUSTMENT_STOCK_UNRESOLVED']};
}
export async function repoListValueAdjustments(articleId:string,unit:string) {
  if(!(await pool.query(sql.VALUE_ADJUSTMENT_CANDIDATE_SQL,[articleId,unit])).rows[0])throw missing();
  const rows=(await pool.query<AdjustmentRow>(sql.VALUE_ADJUSTMENT_LIST_SQL,[articleId,unit])).rows;
  return {items:rows.slice(0,100).map(publicAdjustment),truncated:rows.length>100};
}
export async function repoDeclareValueAdjustment(articleId:string,unit:string,input:DeclareValueAdjustment,audit:MarginAuditContext) {
  const requestHash=createHash('sha256').update(JSON.stringify({article_id:articleId,unit,...input,actor_id:audit.user_id})).digest('hex');
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='500ms'");await tx.query("SET LOCAL statement_timeout='8s'");
    await tx.query(sql.VALUE_ADJUSTMENT_REQUEST_LOCK_SQL,[input.request_id]);
    const replay=(await tx.query<AdjustmentRow>(sql.VALUE_ADJUSTMENT_REQUEST_SQL,[input.request_id])).rows[0];
    if(replay) {
      if(replay.request_hash!==requestHash||!replay.source_valid)throw new HttpError(409,'VALUE_ADJUSTMENT_REQUEST_CONFLICT','Cette demande correspond à une autre validation.');
      await tx.query('COMMIT');return {adjustment:publicAdjustment(replay),replayed:true};
    }
    await tx.query(sql.VALUE_ADJUSTMENT_PROJECTOR_LOCK_SQL);
    const control=(await tx.query(sql.VALUE_ADJUSTMENT_CONTROL_LOCK_SQL)).rows[0];
    if(!control||control.mode!=='ACTIVE'||!control.initialized||control.reporting_currency!=='EUR')
      throw new HttpError(409,'VALUE_ADJUSTMENT_NOT_ACTIVE','La valorisation doit être activée et rapprochée avant cette correction.');
    await tx.query('LOCK TABLE public.stock_valuation_movement_journal IN SHARE MODE');
    const row=(await tx.query<CandidateRow>(sql.VALUE_ADJUSTMENT_CANDIDATE_SQL,[articleId,unit])).rows[0];
    if(!row)throw missing();
    if(row.source_sha256!==input.expected_source_sha256||!row.source_snapshot.eligible||
      !row.source_snapshot.before_state||!row.source_snapshot.previous_entry_id)
      throw new HttpError(409,'VALUE_ADJUSTMENT_CANDIDATE_CHANGED','Actualisez et vérifiez la quantité et la valeur proposées.');
    const document=(await tx.query(OPENING_BASIS_DOCUMENT_LOCK_SQL,[articleId,input.document_id,input.expected_document_sha256])).rows[0];
    if(!document)throw new HttpError(409,'VALUE_ADJUSTMENT_DOCUMENT_CHANGED','Sélectionnez un justificatif actif de cet article.');
    const id=randomUUID(),entryId=randomUUID(),result=applyCumpValueAdjustment(row.source_snapshot.before_state,input.total_value_ht,`stock-valuation-entry:${entryId}`);
    const snapshot={schema_version:1,candidate:row.source_snapshot,document,adjustment_formula:CUMP_VALUE_ADJUSTMENT_FORMULA,
      approval:{created_by:audit.user_id,total_value_ht:input.total_value_ht},result};
    const adjustment=(await tx.query<AdjustmentRow>(sql.VALUE_ADJUSTMENT_INSERT_SQL,[id,entryId,articleId,unit,result.after.quantity,
      result.before.value,result.after.value,result.valueDelta,row.source_snapshot.previous_entry_id,input.document_id,
      input.expected_document_sha256,JSON.stringify(snapshot),input.request_id,requestHash,audit.user_id])).rows[0];
    if(!adjustment)throw new Error('VALUE_ADJUSTMENT_NOT_STORED');
    const proof={schema_version:1,value_adjustment_id:id,value_adjustment_sha256:adjustment.source_sha256,
      previous_entry_id:row.source_snapshot.previous_entry_id,before_state:result.before,after_state:result.after,result};
    const entry=(await tx.query(sql.VALUE_ADJUSTMENT_ENTRY_SQL,[entryId,articleId,unit,control.last_sequence,result.valueDelta,
      result.movementValue,JSON.stringify(proof),JSON.stringify(result.issues),id])).rows[0];
    if(!entry)throw new Error('VALUE_ADJUSTMENT_ENTRY_NOT_STORED');
    await tx.query(CUMP_STORE_BALANCE_SQL,[articleId,'COMPANY',unit,'EUR',result.after.quantity,result.after.value,
      result.after.reliability,result.after.sourceRef,control.last_sequence,entryId]);
    await repoInsertAuditLog({user_id:audit.user_id,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,
      os:audit.os,browser:audit.browser,tx,body:{event_type:'ACTION',action:'STOCK_CURRENT_VALUE_DECLARED',page_key:audit.page_key,
        entity_type:'stock_value_adjustment',entity_id:id,path:audit.path,client_session_id:audit.client_session_id,
        details:{article_id:articleId,unit,currency:'EUR',source_reliability:'DECLARED',source_sha256:adjustment.source_sha256,
          entry_id:entryId,document_id:input.document_id,document_sha256:input.expected_document_sha256}}});
    await tx.query('COMMIT');return {adjustment:publicAdjustment(adjustment),replayed:false};
  } catch(error) {
    await tx.query('ROLLBACK');
    if(error&&typeof error==='object'&&'code' in error&&['55P03','57014','40001','40P01','23505'].includes(String(error.code)))
      throw new HttpError(409,'VALUE_ADJUSTMENT_BUSY','Le stock est en cours de mise à jour. Réessayez la même validation.');
    throw error;
  } finally {tx.release();}
}
