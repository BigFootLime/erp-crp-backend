import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { bindIssuedFinishPurchaseTx, syncOperationFinishTitleTx } from '../../surface-finish/repository/surface-finish-purchase-link.repository';

/** Used by new purchases, existing-line attachment and controlled reconciliation. Caller owns the transaction. */
export async function linkPurchaseOperationTx(tx:Pick<PoolClient,'query'>,input:{pieceId:string;lineId:string;operationId?:string;phase?:number|null;actorId:number}){
 const purchase=(await tx.query<{article_id:string|null;piece_technique_version_id:string|null;type_achat:string;gamme_operation_id:string|null;phase:number|null}>(`SELECT article_id::text,piece_technique_version_id::text,type_achat,gamme_operation_id::text,phase FROM public.pieces_techniques_achats WHERE id=$1::uuid AND piece_technique_id=$2::uuid FOR UPDATE`,[input.lineId,input.pieceId])).rows[0];
 if(!purchase?.article_id||!purchase.piece_technique_version_id||!['MATIERE','TRAITEMENT'].includes(purchase.type_achat))throw new HttpError(422,'PURCHASE_OPERATION_CONTEXT','Sélectionnez un article et un dossier avant le rattachement.');
 const material=purchase.type_achat==='MATIERE';
 const candidates=await tx.query<{id:string;phase:number;designation:string;gamme_id:string}>(`SELECT o.id::text,o.phase,o.designation,o.gamme_id::text FROM public.pieces_techniques_operations o JOIN public.gammes g ON g.id=o.gamme_id WHERE o.piece_technique_id=$1::uuid AND g.piece_technique_version_id=$2::uuid AND g.statut IN ('BROUILLON','EN_VALIDATION') AND o.type_operation=$3 AND o.phase IS NOT NULL AND ($4::uuid IS NOT NULL AND o.id=$4::uuid OR $4::uuid IS NULL AND o.phase=$5) FOR UPDATE OF o,g`,[input.pieceId,purchase.piece_technique_version_id,material?'DECOUPE':'SOUS_TRAITANCE',input.operationId??null,input.phase??null]);
 if(candidates.rows.length!==1)throw new HttpError(422,'PURCHASE_OPERATION_CHOICE','Choisissez une opération compatible dans la fenêtre de gamme ; le numéro de phase seul est ambigu ou indisponible.');
 const operation=candidates.rows[0];
 if(purchase.gamme_operation_id&&purchase.gamme_operation_id!==operation.id)throw new HttpError(409,'PURCHASE_ALREADY_LINKED','Cette ligne est déjà rattachée à une autre opération. Retirez d’abord son association dans la gamme.');
 const article=(await tx.query<{designation_courte:string|null}>(material?`SELECT NULL::text AS designation_courte FROM public.articles WHERE id=$1::uuid AND article_category='matiere' AND is_active`:`SELECT f.designation_courte FROM public.articles a JOIN public.articles_traitement t ON t.article_id=a.id JOIN public.surface_finish_revisions r ON r.id=t.finish_revision_id JOIN public.surface_finishes f ON f.id=r.finish_id WHERE a.id=$1::uuid AND a.is_active AND t.piece_technique_id=$2::uuid AND t.superseded_at IS NULL`,[purchase.article_id,...(material?[]:[input.pieceId])])).rows[0];
 if(!article)throw new HttpError(422,'PURCHASE_ARTICLE_INCOMPATIBLE','Cet article ne correspond pas au besoin ou à cette pièce technique.');
 if(!material&&Number((await tx.query(`SELECT count(*) AS count FROM public.pieces_techniques_achats WHERE gamme_operation_id=$1::uuid AND type_achat='TRAITEMENT' AND id<>$2::uuid`,[operation.id,input.lineId])).rows[0].count)>=2)
  throw new HttpError(422,'OPERATION_FINISH_LIMIT_REACHED','Deux procédés spéciaux au maximum sur une opération.');
 await tx.query(`UPDATE public.pieces_techniques_achats SET gamme_operation_id=$2::uuid,phase=$3,gamme_id=$4::uuid WHERE id=$1::uuid AND (gamme_operation_id IS DISTINCT FROM $2::uuid OR phase IS DISTINCT FROM $3 OR gamme_id IS DISTINCT FROM $4::uuid)`,[input.lineId,operation.id,operation.phase,operation.gamme_id]);
 if(!material){
  await bindIssuedFinishPurchaseTx(tx,{operationId:operation.id,versionId:purchase.piece_technique_version_id,articleId:purchase.article_id,lineId:input.lineId,actorId:input.actorId});
  await syncOperationFinishTitleTx(tx,operation.id);
 }
 return {operation_id:operation.id,phase:operation.phase,type_achat:purchase.type_achat,article_id:purchase.article_id,previous_designation:operation.designation,designation:material?operation.designation:article.designation_courte,designation_preserved:material};
}
