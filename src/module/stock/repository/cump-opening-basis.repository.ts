import { createHash,randomUUID } from 'node:crypto';
import pool from '../../../config/database';
import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import type { MarginAuditContext } from '../../margin-engine/repository/margin-engine.repository';
import type { DeclareOpeningBasis } from '../validators/cump-opening-basis.validators';
import type { CumpOpening } from '../domain/cump-opening';
import * as sql from './cump-opening-basis.sql';

type CandidateRow={source_snapshot:{eligible:boolean;quantity:string;opening_ids:string[]};source_sha256:string};
type BasisRow={id:string;article_id:string;owner_key:string;stock_unit:string;currency:string;quantity:string;
  total_value_ht:string;document_id:string;document_sha256:string;source_reliability:string;source_sha256:string;
  source_valid:boolean;created_by:number;created_at:string;request_hash?:string};
const missing=()=>new HttpError(404,'OPENING_ARTICLE_NOT_FOUND','Article introuvable.');
function publicBasis(row:BasisRow) {
  if(!row.source_valid)throw new HttpError(409,'OPENING_BASIS_PROOF_INVALID','La preuve de valeur d’ouverture doit être vérifiée.');
  const {request_hash:_hash,...basis}=row;return basis;
}
export async function repoOpeningBasisCandidate(articleId:string,unit:string) {
  const row=(await pool.query<CandidateRow>(sql.OPENING_BASIS_CANDIDATE_SQL,[articleId,unit])).rows[0];
  if(!row)throw missing();
  const documents=(await pool.query<{id:string;name:string;sha256:string}>(sql.OPENING_BASIS_DOCUMENTS_SQL,[articleId])).rows;
  return {article_id:articleId,owner:'COMPANY',unit,currency:'EUR',source_reliability:'DECLARED',
    eligible:row.source_snapshot.eligible===true,quantity:row.source_snapshot.eligible===true?row.source_snapshot.quantity:null,
    source_sha256:row.source_sha256,documents:documents.slice(0,100),documents_truncated:documents.length>100,
    issues:row.source_snapshot.eligible===true?[]:['OPENING_QUANTITIES_UNRESOLVED']};
}
export async function repoReadOpeningBasis(articleId:string,unit:string) {
  const candidate=(await pool.query(sql.OPENING_BASIS_CANDIDATE_SQL,[articleId,unit])).rows[0];
  if(!candidate)throw missing();
  const basis=(await pool.query<BasisRow>(sql.OPENING_BASIS_READ_SQL,[articleId,unit])).rows[0];
  return {basis:basis?publicBasis(basis):null};
}
export async function repoDeclareOpeningBasis(articleId:string,unit:string,input:DeclareOpeningBasis,audit:MarginAuditContext) {
  const requestHash=createHash('sha256').update(JSON.stringify({article_id:articleId,unit,...input,actor_id:audit.user_id})).digest('hex');
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN');await tx.query("SET LOCAL lock_timeout='500ms'");await tx.query("SET LOCAL statement_timeout='8s'");
    await tx.query(sql.OPENING_BASIS_REQUEST_LOCK_SQL,[input.request_id]);
    const replay=(await tx.query<BasisRow>(sql.OPENING_BASIS_REQUEST_SQL,[input.request_id])).rows[0];
    if(replay) {
      if(replay.request_hash!==requestHash||!replay.source_valid)
        throw new HttpError(409,'OPENING_BASIS_REQUEST_CONFLICT','Cette demande correspond à une autre déclaration.');
      await tx.query('COMMIT');return {basis:publicBasis(replay),replayed:true};
    }
    const control=(await tx.query(sql.OPENING_BASIS_CONTROL_LOCK_SQL)).rows[0];
    if(!control||control.mode!=='PREPARED'||control.initialized||control.last_sequence!=='0'||control.reporting_currency!=='EUR')
      throw new HttpError(409,'OPENING_BASIS_REQUIRES_CORRECTION','L’ouverture est déjà engagée. Une correction financière distincte est nécessaire.');
    if((await tx.query(sql.OPENING_BASIS_READ_SQL,[articleId,unit])).rows[0])
      throw new HttpError(409,'OPENING_BASIS_ALREADY_DECLARED','Cette ouverture possède déjà une valeur déclarée.');
    const row=(await tx.query<CandidateRow>(sql.OPENING_BASIS_CANDIDATE_SQL,[articleId,unit])).rows[0];
    if(!row)throw missing();
    if(row.source_sha256!==input.expected_source_sha256||row.source_snapshot.eligible!==true)
      throw new HttpError(409,'OPENING_BASIS_CANDIDATE_CHANGED','Actualisez les quantités d’ouverture proposées.');
    const document=(await tx.query(sql.OPENING_BASIS_DOCUMENT_LOCK_SQL,
      [articleId,input.document_id,input.expected_document_sha256])).rows[0];
    if(!document)throw new HttpError(409,'OPENING_BASIS_DOCUMENT_CHANGED','Sélectionnez un document actif de cet article.');
    const snapshot={schema_version:1,opening:row.source_snapshot,document,
      approval:{created_by:audit.user_id,total_value_ht:input.total_value_ht}};
    const basis=(await tx.query<BasisRow>(sql.OPENING_BASIS_INSERT_SQL,[randomUUID(),articleId,unit,row.source_snapshot.quantity,
      input.total_value_ht,input.document_id,input.expected_document_sha256,JSON.stringify(snapshot),
      input.request_id,requestHash,audit.user_id])).rows[0];
    if(!basis)throw new Error('OPENING_BASIS_NOT_STORED');
    await repoInsertAuditLog({user_id:audit.user_id,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,
      os:audit.os,browser:audit.browser,tx,body:{event_type:'ACTION',action:'STOCK_OPENING_VALUE_DECLARED',page_key:audit.page_key,
        entity_type:'stock_opening_basis',entity_id:basis.id,path:audit.path,client_session_id:audit.client_session_id,
        details:{article_id:articleId,unit,currency:'EUR',source_reliability:'DECLARED',source_sha256:basis.source_sha256,
          document_id:input.document_id,document_sha256:input.expected_document_sha256}}});
    await tx.query('COMMIT');return {basis:publicBasis(basis),replayed:false};
  } catch(error) {
    await tx.query('ROLLBACK');
    if(error&&typeof error==='object'&&'code' in error&&['55P03','57014','40001','40P01','23505'].includes(String(error.code)))
      throw new HttpError(409,'OPENING_BASIS_BUSY','Cette ouverture est en cours de validation. Actualisez puis réessayez la même demande.');
    throw error;
  } finally {tx.release();}
}

/** Internal projector adapter only, in the same transaction as the opening entry. */
export async function readDeclaredOpeningValueTx(tx:Pick<PoolClient,'query'>,opening:CumpOpening) {
  const scope=opening.state.scope;
  if(scope.owner!=='COMPANY'||scope.currency!=='EUR'||opening.state.quantity==='0')return null;
  const row=(await tx.query<{id:string;total_value_ht:string;source_sha256:string;source_valid:boolean}>(
    sql.OPENING_BASIS_INTERNAL_SQL,[scope.articleId,scope.owner,scope.unit,scope.currency,
      opening.state.quantity,JSON.stringify(opening.openingIds)])).rows[0];
  if(!row)return null;
  return row.source_valid?{value:row.total_value_ht,proof:{opening_basis_id:row.id,opening_basis_sha256:row.source_sha256}}:
    {value:null,proof:{issues:['OPENING_BASIS_PROOF_INVALID']}};
}
