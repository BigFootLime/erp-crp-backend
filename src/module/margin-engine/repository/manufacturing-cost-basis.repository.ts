import { createHash, randomUUID } from 'node:crypto';
import pool from '../../../config/database';
import { HttpError } from '../../../utils/httpError';
import { repoInsertAuditLog } from '../../audit-logs/repository/audit-logs.repository';
import { readManufacturingBasisCandidate, type ManufacturingBasisSource } from '../domain/manufacturing-cost-basis';
import type { DeclareManufacturingBasis } from '../validators/manufacturing-cost-basis.validators';
import type { MarginAuditContext } from './margin-engine.repository';
import { MANUFACTURING_BASIS_CANDIDATE_SQL, MANUFACTURING_BASIS_INSERT_SQL,
  MANUFACTURING_BASIS_READ_SQL, MANUFACTURING_BASIS_REQUEST_SQL,
  MANUFACTURING_BASIS_ORDER_EXISTS_SQL, MANUFACTURING_BASIS_REQUEST_LOCK_SQL,
  MANUFACTURING_BASIS_CONTROL_LOCK_SQL, MANUFACTURING_BASIS_ORDER_LOCK_SQL,
  MANUFACTURING_BASIS_PROJECTED_SQL, MANUFACTURING_BASIS_OPERATIONS_LOCK_SQL } from './manufacturing-cost-basis.sql';

type BasisRow={id:string;of_id:string;margin_snapshot_id:string;quantity_good:string;total_cost_ht:string;
  currency:string;source_reliability:string;source_sha256:string;source_valid:boolean;created_by:number;
  created_at:string;request_hash?:string};
const publicBasis=(row:BasisRow)=>{
  if(!row.source_valid) throw new HttpError(409,'MANUFACTURING_BASIS_PROOF_INVALID','La preuve du coût de fabrication doit être vérifiée avant consultation.');
  const {request_hash:_requestHash,...basis}=row;return basis;
};
const notFound=()=>new HttpError(404,'MANUFACTURING_ORDER_NOT_FOUND','OF introuvable.');

export async function repoManufacturingBasisCandidate(ofId:string,snapshotId:string) {
  const row=(await pool.query<ManufacturingBasisSource>(MANUFACTURING_BASIS_CANDIDATE_SQL,[ofId,snapshotId])).rows[0];
  if(!row) throw notFound();
  return readManufacturingBasisCandidate(row,ofId,snapshotId);
}
export async function repoReadManufacturingBasis(ofId:string) {
  const exists=await pool.query(MANUFACTURING_BASIS_ORDER_EXISTS_SQL,[ofId]);
  if(!exists.rows[0]) throw notFound();
  const row=(await pool.query<BasisRow>(MANUFACTURING_BASIS_READ_SQL,[ofId])).rows[0];
  return {basis:row?publicBasis(row):null};
}

export async function repoDeclareManufacturingBasis(ofId:string,input:DeclareManufacturingBasis,audit:MarginAuditContext) {
  const requestHash=createHash('sha256').update(JSON.stringify({of_id:ofId,...input,actor_id:audit.user_id})).digest('hex');
  const tx=await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='500ms'");
    await tx.query("SET LOCAL statement_timeout='8s'");
    await tx.query(MANUFACTURING_BASIS_REQUEST_LOCK_SQL,[input.request_id]);
    const replay=(await tx.query<BasisRow>(MANUFACTURING_BASIS_REQUEST_SQL,[input.request_id])).rows[0];
    if(replay) {
      if(replay.request_hash!==requestHash||!replay.source_valid)
        throw new HttpError(409,'MANUFACTURING_BASIS_REQUEST_CONFLICT','Cette demande correspond à une autre validation.');
      await tx.query('COMMIT');return {basis:publicBasis(replay),replayed:true};
    }
    // Same lock order as the projector: its control precedes manufacturing state.
    const control=await tx.query(MANUFACTURING_BASIS_CONTROL_LOCK_SQL);
    if(!control.rows[0]) throw new HttpError(409,'MANUFACTURING_PROJECTOR_CONTROL_MISSING','Préparation Stock indisponible.');
    const order=await tx.query(MANUFACTURING_BASIS_ORDER_LOCK_SQL,[ofId]);
    if(!order.rows[0]) throw notFound();
    if((await tx.query(MANUFACTURING_BASIS_READ_SQL,[ofId])).rows[0])
      throw new HttpError(409,'MANUFACTURING_BASIS_ALREADY_DECLARED','Cet OF possède déjà une base de coût figée.');
    const projected=await tx.query(MANUFACTURING_BASIS_PROJECTED_SQL,[ofId]);
    if(projected.rows[0]) throw new HttpError(409,'MANUFACTURING_BASIS_REQUIRES_VALUE_CORRECTION',
      'Une réception a déjà été valorisée. Une correction financière distincte est nécessaire.');
    await tx.query(MANUFACTURING_BASIS_OPERATIONS_LOCK_SQL,[ofId]);
    const row=(await tx.query<ManufacturingBasisSource>(MANUFACTURING_BASIS_CANDIDATE_SQL,[ofId,input.margin_snapshot_id])).rows[0];
    if(!row||row.source_sha256!==input.expected_source_sha256)
      throw new HttpError(409,'MANUFACTURING_BASIS_CANDIDATE_CHANGED','Les données ont changé. Actualisez la base de coût proposée.');
    const candidate=readManufacturingBasisCandidate(row,ofId,input.margin_snapshot_id);
    if(!candidate.eligible||candidate.quantity_good===null||candidate.total_cost_ht===null)
      throw new HttpError(409,'MANUFACTURING_BASIS_INCOMPLETE','Complétez ou actualisez les données de fabrication avant de valider ce coût.',{issues:candidate.issues});
    const basis=(await tx.query<BasisRow>(MANUFACTURING_BASIS_INSERT_SQL,[randomUUID(),ofId,input.margin_snapshot_id,
      candidate.quantity_good,candidate.total_cost_ht,JSON.stringify(row.source_snapshot),row.source_sha256,
      input.request_id,requestHash,audit.user_id])).rows[0]!;
    await repoInsertAuditLog({user_id:audit.user_id,ip:audit.ip,user_agent:audit.user_agent,device_type:audit.device_type,
      os:audit.os,browser:audit.browser,tx,body:{event_type:'ACTION',action:'MANUFACTURING_COST_BASIS_DECLARED',
        page_key:audit.page_key,entity_type:'manufacturing_cost_basis',entity_id:basis.id,path:audit.path,
        client_session_id:audit.client_session_id,details:{of_id:ofId,margin_snapshot_id:input.margin_snapshot_id,
          source_sha256:basis.source_sha256,source_reliability:'DECLARED',currency:'EUR'}}});
    await tx.query('COMMIT');return {basis:publicBasis(basis),replayed:false};
  } catch(error) {
    await tx.query('ROLLBACK');
    if(error&&typeof error==='object'&&'code' in error&&['55P03','57014','40001','40P01'].includes(String(error.code)))
      throw new HttpError(409,'MANUFACTURING_BASIS_BUSY','Cet OF est en cours de mise à jour. Réessayez la même validation.');
    throw error;
  } finally {tx.release();}
}
