import type {PoolClient} from "pg";
import {HttpError} from "../../../utils/httpError";
/** Legacy adapters must not create a second economic commitment, including
 * after a rollout flag is disabled while new allocations still exist. */
export async function assertLegacyMaterialWrite(tx:Pick<PoolClient,"query">,ofId:number,articleId:string|null){
  const installed=(await tx.query("SELECT to_regclass('public.of_material_needs') IS NOT NULL AS installed")).rows[0]?.installed;
  if(!installed)return;
  await tx.query("SELECT id FROM public.ordres_fabrication WHERE id=$1 FOR UPDATE",[ofId]);
  const guarded=(await tx.query(`SELECT EXISTS(SELECT 1 FROM public.of_material_needs n WHERE n.of_id=$1 AND($2::uuid IS NULL OR n.article_id=$2::uuid))
    OR EXISTS(SELECT 1 FROM public.ordres_fabrication o, jsonb_array_elements(COALESCE(o.technical_snapshot->'preparation_evidence'->'purchases','[]')) p
      WHERE o.id=$1 AND($2::uuid IS NULL OR p->>'article_id'=$2::text)
        AND(p->>'type_achat'='CONSOMMABLE' OR(p->>'type_achat'='MATIERE' AND EXISTS(SELECT 1 FROM public.app_feature_flags WHERE key='PRODUCTION_MATERIAL_WORKFLOW' AND enabled)))) AS guarded`,[ofId,articleId])).rows[0]?.guarded;
  if(guarded)throw new HttpError(409,"OF_MATERIAL_COVERAGE_REQUIRED","Ouvrez les approvisionnements du dossier OF pour vérifier la couverture et préparer uniquement le manque.",{of_id:ofId});
}
