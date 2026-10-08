import type { PoolClient } from 'pg';
import pool from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { proposeMaterialInvoiceReconciliation,type MaterialReconciliationSources } from './material-invoice-reconciliation';
import { MATERIAL_SOURCE_SQL,MATERIAL_POSTING_HISTORY_SQL } from './material-invoice-posting.sql';

/** One total deadline applies to all queries, including lock waits and commit. */
export function materialInvoiceQueries(tx:PoolClient,deadline:number) {
  return async<T extends Record<string,unknown>>(statement:string,values:unknown[]=[])=>{
    const remaining=deadline-Date.now();
    if(remaining<100)throw new HttpError(409,'MATERIAL_RECONCILIATION_BUSY','Le contrôle matière prend trop de temps. Réessayez.');
    await tx.query("SELECT set_config('statement_timeout',$1,true)",[`${remaining}ms`]);
    return (await tx.query<T>(statement,values)).rows;
  };
}
export async function readMaterialInvoiceSourcesTx(query:ReturnType<typeof materialInvoiceQueries>,invoiceId:string) {
  const source=(await query<{source:MaterialReconciliationSources|null}>(MATERIAL_SOURCE_SQL,[invoiceId]))[0]?.source;
  if(!source)throw new HttpError(404,'SUPPLIER_INVOICE_NOT_FOUND','Facture introuvable.');
  if(Buffer.byteLength(JSON.stringify(source),'utf8')>8*1024*1024)
    throw new HttpError(409,'MATERIAL_RECONCILIATION_TOO_DENSE','Le dossier matière est trop volumineux pour ce contrôle.');
  return source;
}
export type MaterialPostingHistoryRow={id:string;invoice_id:string;request_hash:string;source_sha256:string;
  source_valid:boolean;response:unknown};
export function publicMaterialInvoicePosting(row:MaterialPostingHistoryRow) {
  if(!row.source_valid)throw new HttpError(409,'MATERIAL_RECONCILIATION_PROOF_INVALID','La preuve du rapprochement doit être vérifiée.');
  return row.response;
}

/** A preview never locks Stock or approves an invoice. Queries share one
 * snapshot and a nine-second total deadline, below the reverse-proxy timeout. */
export async function repoMaterialInvoiceReconciliation(invoiceId:string) {
  const tx=await pool.connect(),query=materialInvoiceQueries(tx,Date.now()+9000);
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.query("SET LOCAL lock_timeout='500ms'");
    const source=await readMaterialInvoiceSourcesTx(query,invoiceId);
    const row=(await query<MaterialPostingHistoryRow>(MATERIAL_POSTING_HISTORY_SQL,[invoiceId]))[0];
    const proposal=proposeMaterialInvoiceReconciliation(source);
    const result={...proposal,applied:!!row,posting_available:!row,requires_financial_confirmation:!row,
      applied_reconciliation:row?publicMaterialInvoicePosting(row):null};
    await query('COMMIT');return result;
  } catch(error) {
    await tx.query('ROLLBACK');
    if(error&&typeof error==='object'&&'code' in error&&['55P03','57014','40001','40P01'].includes(String(error.code)))
      throw new HttpError(409,'MATERIAL_RECONCILIATION_BUSY','Le stock est en cours de mise à jour. Réessayez le contrôle.');
    throw error;
  } finally {tx.release();}
}
