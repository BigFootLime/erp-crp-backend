import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { computeSpecFingerprint, type CanonicalFinishSpec } from '../domain/surface-finish-policy';

/** Bind an issued PS article through the canonical route-finish record, in the purchase transaction. */
export async function bindIssuedFinishPurchaseTx(tx:Pick<PoolClient,'query'>,input:{operationId:string;versionId:string;articleId:string;lineId:string;actorId:number}){
  const row=(await tx.query<{gamme_id:string;finish_revision_id:string;spec_canonical:CanonicalFinishSpec|null;spec_fingerprint:string|null;designation:string;generated_comment:string|null;template_version:number|null}>(`
    SELECT o.gamme_id::text,t.finish_revision_id::text,t.spec_canonical,t.spec_fingerprint,a.designation,t.generated_comment,t.template_version
    FROM public.articles a JOIN public.articles_traitement t ON t.article_id=a.id
    JOIN public.pieces_techniques_operations o ON o.id=$1::uuid JOIN public.gammes g ON g.id=o.gamme_id
    WHERE a.id=$2::uuid AND a.is_active AND t.superseded_at IS NULL AND t.piece_technique_id=o.piece_technique_id
      AND g.piece_technique_version_id=$3::uuid AND o.type_operation='SOUS_TRAITANCE' AND g.statut IN ('BROUILLON','EN_VALIDATION')`,[input.operationId,input.articleId,input.versionId])).rows[0];
  const issuedSpec=row?.spec_canonical;
  if(!row||!issuedSpec||issuedSpec.finish_revision_id!==row.finish_revision_id||computeSpecFingerprint(issuedSpec)!==row.spec_fingerprint)
    throw new HttpError(422,'PS_ARTICLE_REQUIREMENT_INVALID','Cet article ne porte pas une définition de finition valide pour ce dossier.');
  // Match the established resolver: reuse an issued article of the same PT when all process requirements are unchanged.
  // The operation requirement belongs to its own dossier; the issued article and its original fingerprint stay immutable.
  const spec={...issuedSpec,piece_technique_version_id:input.versionId};
  const fingerprint=computeSpecFingerprint(spec);
  const existing=(await tx.query<{slot:number}>(`SELECT slot FROM public.gamme_operation_finitions WHERE gamme_operation_id=$1::uuid AND (achat_ligne_id=$2::uuid OR article_id=$3::uuid)`,[input.operationId,input.lineId,input.articleId])).rows[0];
  const slot=existing?.slot ?? (await tx.query<{slot:number}>(`SELECT s AS slot FROM generate_series(1,2) s WHERE NOT EXISTS(SELECT 1 FROM public.gamme_operation_finitions f WHERE f.gamme_operation_id=$1::uuid AND f.slot=s) ORDER BY s LIMIT 1`,[input.operationId])).rows[0]?.slot;
  if(!slot)throw new HttpError(422,'OPERATION_FINISH_LIMIT_REACHED','Deux procédés spéciaux au maximum sur une opération.');
  const columns=['gamme_id','gamme_operation_id','piece_technique_version_id','finish_revision_id','perimetre','zones','masquages','norme','classe','epaisseur_min','epaisseur_nominale','epaisseur_max','epaisseur_unite','couleur','teinte_ral','aspect','rugosite','durete','exigence_corrosion','pretraitement','posttraitement','controles','certificat_requis','certificat_type','conditionnement','unite_achat','specification_client','specification_client_version','instructions','spec_canonical','spec_fingerprint','article_id','achat_ligne_id','generated_designation','generated_comment','template_version','created_by','updated_by','slot'];
  const values=[row.gamme_id,input.operationId,input.versionId,row.finish_revision_id,spec.perimetre,spec.zones,spec.masquages,spec.norme,spec.classe,spec.epaisseur_min_um,spec.epaisseur_nominale_um,spec.epaisseur_max_um,'um',spec.couleur,spec.teinte_ral,spec.aspect,spec.rugosite,spec.durete,spec.exigence_corrosion,spec.pretraitement,spec.posttraitement,spec.controles,spec.certificat_requis,spec.certificat_type,spec.conditionnement,spec.unite_achat,spec.specification_client,spec.specification_client_version,spec.instructions,JSON.stringify(spec),fingerprint,input.articleId,input.lineId,row.designation,row.generated_comment??'',row.template_version??1,input.actorId,input.actorId];
  const saved=await tx.query(`INSERT INTO public.gamme_operation_finitions (${columns.join(',')}) VALUES (${columns.map((_,index)=>'$'+(index+1)).join(',')})
    ON CONFLICT (gamme_operation_id,slot) DO UPDATE SET achat_ligne_id=EXCLUDED.achat_ligne_id,updated_by=EXCLUDED.updated_by,updated_at=now()
    WHERE gamme_operation_finitions.article_id=EXCLUDED.article_id AND gamme_operation_finitions.piece_technique_version_id=EXCLUDED.piece_technique_version_id
      AND (gamme_operation_finitions.spec_canonical-'piece_technique_version_id'-'finish_revision_id')=(EXCLUDED.spec_canonical-'piece_technique_version_id'-'finish_revision_id')
      AND (gamme_operation_finitions.achat_ligne_id IS NULL OR gamme_operation_finitions.achat_ligne_id=EXCLUDED.achat_ligne_id)`,[...values,slot]);
  if(!saved.rowCount)throw new HttpError(409,'OPERATION_FINISH_ALREADY_LINKED','Cette opération porte déjà un procédé spécial. Modifiez sa finition dans la gamme ou choisissez une autre opération.');
}

export async function syncOperationFinishTitleTx(tx:Pick<PoolClient,'query'>,operationId:string){
 await tx.query(`UPDATE public.pieces_techniques_operations o SET designation=s.title,designation_auto=false,updated_at=now() FROM (SELECT string_agg(f.designation_courte,' / ' ORDER BY r.slot) AS title FROM public.gamme_operation_finitions r JOIN public.surface_finish_revisions v ON v.id=r.finish_revision_id JOIN public.surface_finishes f ON f.id=v.finish_id WHERE r.gamme_operation_id=$1::uuid) s WHERE o.id=$1::uuid AND s.title IS NOT NULL AND (o.designation IS DISTINCT FROM s.title OR o.designation_auto)`,[operationId]);
}
