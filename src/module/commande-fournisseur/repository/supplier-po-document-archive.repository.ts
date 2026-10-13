import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {authoritativePdfFilename} from '../../../shared/authoritative-documents/authoritative-document.filename';
import {queueFrozenCommercialPdfArchive} from '../../../shared/authoritative-documents/authoritative-document.service';
import {repoFindAuthoritativePdfByIdempotency} from '../../../shared/authoritative-documents/authoritative-document.repository';

type Db=Pick<PoolClient,'query'>;
type FrozenDocument={id:string;version:number;payload:Record<string,unknown>};

/** The order header must be locked by the caller. Archive editions include the
 * historical creation draft; don't collide with v1 or replace its exact bytes. */
export async function queueFrozenSupplierDocumentTx(tx:Db,orderId:string,document:FrozenDocument,actor:number) {
  const key='commande-fournisseur:'+orderId+':freeze:'+document.id;
  const prior=await repoFindAuthoritativePdfByIdempotency(tx,key);
  if(prior){
    if(prior.entityType!=='commande-fournisseur'||prior.entityId!==orderId||prior.documentKind!=='SUPPLIER_PURCHASE_ORDER')
      throw new HttpError(409,'OFFICIAL_DOCUMENT_IDEMPOTENCY_CONFLICT','Cette édition appartient à un autre document.');
    return prior;
  }
  const source=document.payload.official_snapshot;
  const revision=document.payload.official_source_revision;
  if(!source||typeof source!=='object'||Array.isArray(source)||typeof revision!=='string'||!revision.trim())
    throw new HttpError(409,'OFFICIAL_DOCUMENT_FROZEN_SOURCE_MISSING','Ce gel ancien ne contient pas encore sa source PDF. Une régularisation documentaire est nécessaire.');
  const snapshot=source as Record<string,unknown>;
  if(snapshot.type!=='SUPPLIER_PURCHASE_ORDER'||snapshot.status!=='APPROUVEE'||typeof snapshot.code!=='string'||
      !Object.prototype.hasOwnProperty.call(snapshot,'general_terms')||!snapshot.issuer||!Array.isArray(snapshot.lines))
    throw new HttpError(409,'OFFICIAL_DOCUMENT_FROZEN_SOURCE_INVALID','La source figée du bon de commande est incomplète.');
  const edition=Number((await tx.query<{version:number}>(`SELECT COALESCE(max(document_version),0)+1 AS version
    FROM public.authoritative_pdf_archives WHERE entity_type='commande-fournisseur' AND entity_id=$1
      AND document_kind='SUPPLIER_PURCHASE_ORDER'`,[orderId])).rows[0]?.version);
  return queueFrozenCommercialPdfArchive(tx,{
    entityType:'commande-fournisseur',entityId:orderId,documentKind:'SUPPLIER_PURCHASE_ORDER',
    documentVersion:edition,renderVersion:'supplier-po-pdf-v1',idempotencyKey:key,
    title:'Bon de commande fournisseur '+snapshot.code,
    originalName:authoritativePdfFilename(['BCF',snapshot.code,'v'+edition]),
    sourceRevision:revision,sourceSnapshot:{...snapshot,frozen_document:{id:document.id,version:document.version}},
    actorUserId:actor,
  });
}
