import type {PoolClient} from 'pg';

// Conservative identity: any buyer change, including a note, makes the whole
// draft ineligible. Existing lines are never merged or rewritten automatically.
const contentHash=`md5(jsonb_build_object('header',to_jsonb(c),'lines',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.position,l.id)
  FROM public.commande_fournisseur_ligne l WHERE l.commande_id=c.id),'[]'::jsonb),
  'allocations',COALESCE((SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM public.commande_fournisseur_ligne_besoin b
    JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id WHERE l.commande_id=c.id),'[]'::jsonb))::text)`;

export async function findUntouchedMaterialDraftTx(tx:PoolClient,input:{supplierId:string;currency:string;destinationId:string|null}){
  const candidates=(await tx.query<{id:string;code:string}>(`SELECT c.id::text,c.code FROM public.commande_fournisseur c
    JOIN public.of_material_draft_baselines b ON b.commande_id=c.id
    WHERE c.statut='BROUILLON' AND c.origine='RUPTURE_OF' AND c.fournisseur_id=$1::uuid AND c.devise=$2
      AND c.magasin_livraison_id IS NOT DISTINCT FROM $3::uuid
      AND NOT EXISTS(SELECT 1 FROM public.supplier_consultations sc WHERE sc.commande_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM public.reception_fournisseur_lignes r JOIN public.commande_fournisseur_ligne l ON l.id=r.commande_fournisseur_ligne_id WHERE l.commande_id=c.id)
    ORDER BY c.created_at,c.id FOR UPDATE OF c`,[input.supplierId,input.currency,input.destinationId])).rows;
  for(const candidate of candidates){
    const row=(await tx.query<{unchanged:boolean}>(`SELECT b.content_hash=${contentHash} AS unchanged FROM public.commande_fournisseur c
      JOIN public.of_material_draft_baselines b ON b.commande_id=c.id WHERE c.id=$1::uuid`,[candidate.id])).rows[0];
    if(row?.unchanged)return candidate;
  }
  return null;
}

export async function recordMaterialDraftBaselineTx(tx:PoolClient,id:string){
  await tx.query(`INSERT INTO public.of_material_draft_baselines(commande_id,content_hash)
    SELECT c.id,${contentHash} FROM public.commande_fournisseur c WHERE c.id=$1::uuid
    ON CONFLICT(commande_id) DO UPDATE SET content_hash=EXCLUDED.content_hash,updated_at=now()`,[id]);
}
