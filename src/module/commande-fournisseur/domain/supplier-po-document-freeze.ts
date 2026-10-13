import {createHash} from 'node:crypto';

/** The standard UI round-trips the exact source token. An identical retry uses
 * the same request, even after the order moves to Sent. A genuinely new edition
 * uses its newly loaded source token and an explicit revision reason. */
export function supplierDocumentFreezeRequestKey(orderId:string,sourceToken:string|undefined,reason:string|undefined) {
  if (!sourceToken?.trim()) return null;
  const digest=createHash('sha256').update(JSON.stringify([orderId,sourceToken,reason?.trim()??null])).digest('hex');
  return 'supplier-po-freeze:'+digest;
}
