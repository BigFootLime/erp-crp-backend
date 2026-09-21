import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { SubcontractDefinition } from "../validators/subcontract-definition";

export async function syncSubcontractDefinitionTx(tx:PoolClient,id:string,definition:SubcontractDefinition|undefined,userId:number|null){
  if(definition===undefined)return;
  const valid=(await tx.query(`SELECT a.id FROM public.articles a
    JOIN public.article_category_link c ON c.article_id=a.id AND c.category_code='sous_traitance'
    JOIN public.pieces_techniques p ON p.id=$2::uuid
    JOIN public.piece_technique_versions v ON v.id=$3::uuid AND v.piece_technique_id=p.id
    WHERE a.id=$1::uuid AND a.article_category='achat' FOR SHARE OF p,v`,[id,definition.piece_technique_id,definition.piece_technique_version_id])).rows[0];
  if(!valid)throw new HttpError(422,"SUBCONTRACT_DEFINITION_INVALID","Sélectionnez une pièce et un indice cohérents pour cet article de sous-traitance.");
  await tx.query(`INSERT INTO public.article_subcontract_definition(article_id,piece_technique_id,piece_technique_version_id,
    family_label,description,material_provider,plan_reference,comment,updated_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(article_id) DO UPDATE SET piece_technique_id=EXCLUDED.piece_technique_id,piece_technique_version_id=EXCLUDED.piece_technique_version_id,
      family_label=EXCLUDED.family_label,description=EXCLUDED.description,material_provider=EXCLUDED.material_provider,
      plan_reference=EXCLUDED.plan_reference,comment=EXCLUDED.comment,updated_at=now(),updated_by=EXCLUDED.updated_by`,
    [id,definition.piece_technique_id,definition.piece_technique_version_id,definition.family_label,definition.description,
      definition.material_provider,definition.plan_reference,definition.comment??null,userId]);
}
