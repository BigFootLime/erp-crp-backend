import pool from '../../config/database';
import { HttpError } from '../../utils/httpError';
import { materialReceiptScopes,proposeMaterialInvoiceReconciliation,
  type MaterialInvoiceSource,type MaterialInvoiceLine,type MaterialReceipt,type MaterialLot,
  type MaterialTrace,type MaterialBalance } from './material-invoice-reconciliation';
import * as sql from './material-invoice-reconciliation.sql';

/** A preview never locks Stock or approves an invoice. Queries share one
 * snapshot and a nine-second total deadline, below the reverse-proxy timeout. */
export async function repoMaterialInvoiceReconciliation(invoiceId:string) {
  const tx=await pool.connect(),deadline=Date.now()+9000;
  async function read<T extends Record<string,unknown>>(statement:string,values:unknown[]) {
    const remaining=deadline-Date.now();
    if(remaining<100)throw new HttpError(409,'MATERIAL_RECONCILIATION_BUSY','Le contrôle matière prend trop de temps. Réessayez.');
    await tx.query("SELECT set_config('statement_timeout',$1,true)",[`${remaining}ms`]);
    return (await tx.query<T>(statement,values)).rows;
  }
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await tx.query("SET LOCAL lock_timeout='500ms'");
    const invoice=(await read<MaterialInvoiceSource>(sql.MATERIAL_INVOICE_SOURCE_SQL,[invoiceId]))[0];
    if(!invoice)throw new HttpError(404,'SUPPLIER_INVOICE_NOT_FOUND','Facture introuvable.');
    const lines=await read<MaterialInvoiceLine>(sql.MATERIAL_INVOICE_LINES_SQL,[invoiceId,invoice.match_id,invoice.order_id]);
    const receiptIds=[...new Set(lines.flatMap(l=>l.receipt_ids))].sort();
    // Oversized sources produce an explained preview rather than a partial sum.
    const receipts=receiptIds.length<=500?await read<MaterialReceipt>(sql.MATERIAL_INVOICE_RECEIPTS_SQL,[receiptIds]):[];
    const {lotIds,scopes}=materialReceiptScopes(receipts);
    const withinLimit=lines.length<=500&&receiptIds.length<=500&&receipts.length<=500&&lotIds.length<=500&&scopes.length<=500;
    const lots=withinLimit?await read<MaterialLot>(sql.MATERIAL_INVOICE_LOTS_SQL,[lotIds]):[];
    const trace=withinLimit?await read<MaterialTrace>(sql.MATERIAL_INVOICE_TRACE_SQL,[lotIds]):[];
    const balances=withinLimit?await read<MaterialBalance>(sql.MATERIAL_INVOICE_BALANCES_SQL,[JSON.stringify(scopes)]):[];
    const source={invoice,lines,receipts,lots,trace,balances,complete:withinLimit&&trace.length<=2000
      &&receipts.every(r=>r.proof_complete)&&trace.every(t=>t.proof_complete)};
    if(Buffer.byteLength(JSON.stringify(source),'utf8')>8*1024*1024)
      throw new HttpError(409,'MATERIAL_RECONCILIATION_TOO_DENSE','Le dossier matière est trop volumineux pour ce contrôle.');
    const proposal=proposeMaterialInvoiceReconciliation(source);
    await tx.query('COMMIT');return proposal;
  } catch(error) {
    await tx.query('ROLLBACK');
    if(error&&typeof error==='object'&&'code' in error&&['55P03','57014','40001','40P01'].includes(String(error.code)))
      throw new HttpError(409,'MATERIAL_RECONCILIATION_BUSY','Le stock est en cours de mise à jour. Réessayez le contrôle.');
    throw error;
  } finally {tx.release();}
}
