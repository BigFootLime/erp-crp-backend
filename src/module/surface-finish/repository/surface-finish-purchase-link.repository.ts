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
  const columns=['gamme_id','gamme_operation_id','piece_technique_version_id','finish_revision_id','perimetre','zones','masquages','norme','classe','epaisseur_min','epaisseur_nominale','epaisseur_max','epaisseur_unite','couleur','teinte_ral','aspect','rugosite','durete','exigence_corrosion','pretraitement','posttraitement','controles','certificat_requis','certificat_type','conditionnement','unite_achat','specification_client','specification_client_version','instructions','spec_canonical','spec_fingerprint','article_id','achat_ligne_id','generated_designation','generated_comment','template_version','created_by','updated_by'];
  const values=[row.gamme_id,input.operationId,input.versionId,row.finish_revision_id,spec.perimetre,spec.zones,spec.masquages,spec.norme,spec.classe,spec.epaisseur_min_um,spec.epaisseur_nominale_um,spec.epaisseur_max_um,'um',spec.couleur,spec.teinte_ral,spec.aspect,spec.rugosite,spec.durete,spec.exigence_corrosion,spec.pretraitement,spec.posttraitement,spec.controles,spec.certificat_requis,spec.certificat_type,spec.conditionnement,spec.unite_achat,spec.specification_client,spec.specification_client_version,spec.instructions,JSON.stringify(spec),fingerprint,input.articleId,input.lineId,row.designation,row.generated_comment??'',row.template_version??1,input.actorId,input.actorId];
  const saved=await tx.query(`INSERT INTO public.gamme_operation_finitions (${columns.join(',')}) VALUES (${values.map((_,index)=>'$'+(index+1)).join(',')})
    ON CONFLICT (gamme_operation_id) DO UPDATE SET achat_ligne_id=EXCLUDED.achat_ligne_id,updated_by=EXCLUDED.updated_by,updated_at=now()
    WHERE gamme_operation_finitions.article_id=EXCLUDED.article_id AND gamme_operation_finitions.piece_technique_version_id=EXCLUDED.piece_technique_version_id
      AND (gamme_operation_finitions.spec_canonical-'piece_technique_version_id'-'finish_revision_id')=(EXCLUDED.spec_canonical-'piece_technique_version_id'-'finish_revision_id')
      AND (gamme_operation_finitions.achat_ligne_id IS NULL OR gamme_operation_finitions.achat_ligne_id=EXCLUDED.achat_ligne_id)`,values);
  if(!saved.rowCount)throw new HttpError(409,'OPERATION_FINISH_ALREADY_LINKED','Cette opération porte déjà un procédé spécial. Modifiez sa finition dans la gamme ou choisissez une autre opération.');
}
