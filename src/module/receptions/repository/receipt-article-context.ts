/** These SQL fragments receive repository-owned aliases, never request values. */
export function receiptArticleContextSql(articleAlias:string,ownerSql?:string){
  const owner=ownerSql??`(SELECT client_proprietaire_id FROM public.articles_matiere WHERE article_id=${articleAlias}.id)`;
  return `jsonb_build_object(
    'ownerClientId',${owner},
    'ownerClientName',(SELECT company_name FROM public.clients WHERE client_id=${owner}),
    'material',(SELECT jsonb_build_object('profile',m.family_code,'barToCut',m.barre_a_decouper,
      'grade',(SELECT n.code FROM public.stock_nuances n WHERE n.id=m.nuance_id),
      'sourceLengthMm',m.longueur_barre_source_mm,'cutLengthMm',m.longueur_coupe_mm,'blankLengthMm',m.longueur_brut_mm,
      'lengthMm',m.longueur_mm,'unitLengthMm',m.longueur_unitaire_mm,
      'widthMm',m.largeur_mm,'heightMm',m.hauteur_mm,'thicknessMm',m.epaisseur_mm,'diameterMm',m.diametre_mm,'acrossFlatsMm',m.largeur_plat_mm)
      FROM public.articles_matiere m WHERE m.article_id=${articleAlias}.id),
    'subcontract',(SELECT jsonb_build_object('pieceReference',p.code_piece,'pieceDesignation',p.designation,'revision',v.indice,
      'family',d.family_label,'description',d.description,'materialProvider',d.material_provider,'planReference',d.plan_reference,'comment',d.comment)
      FROM public.article_subcontract_definition d JOIN public.pieces_techniques p ON p.id=d.piece_technique_id
      JOIN public.piece_technique_versions v ON v.id=d.piece_technique_version_id WHERE d.article_id=${articleAlias}.id),
    'treatment',(SELECT jsonb_build_object('pieceReference',p.code_piece,'pieceDesignation',p.designation,'revision',v.indice,
      'type',f.procede,'family',f.family_code,'planReference',v.plan_reference,'comment',t.generated_comment)
      FROM public.articles_traitement t JOIN public.pieces_techniques p ON p.id=t.piece_technique_id
      JOIN public.piece_technique_versions v ON v.id=t.piece_technique_version_id
      JOIN public.surface_finish_revisions fr ON fr.id=t.finish_revision_id JOIN public.surface_finishes f ON f.id=fr.finish_id
      WHERE t.article_id=${articleAlias}.id)
  )`;
}
export const offStockServiceEligibilitySql = `l.type='PRESTATION' AND l.article_id IS NULL
  AND NOT COALESCE(l.receipt_stock_managed,false) AND NOT COALESCE(l.receipt_quality_required,false)
  AND COALESCE(l.receipt_consumption_mode,'UNIT')='UNIT'
  AND COALESCE(l.receipt_processing_policy,'STANDARD')='STANDARD'
  AND l.receipt_tool_id IS NULL AND l.exigences_qualite='[]'::jsonb`;

// Aliases come from readProcessingLine. A required formal control remains on its existing path.
export const receiptOperatorKindSql = `CASE WHEN a.article_category='matiere' AND l.receipt_quality_required AND l.stock_managed
  AND l.receipt_tool_id IS NULL AND r.origin_type='SUPPLIER' AND r.confirmation_state IS DISTINCT FROM 'DRAFT'
  AND r.status IN ('OPEN','CLOSED') AND lot.lot_status IN ('EN_ATTENTE','QUARANTAINE')
  AND (lot.expiry_at IS NULL OR lot.expiry_at > now()) AND lot.article_id=l.article_id
  AND coalesce(cl.type,'') NOT IN ('SOUS_TRAITANCE','TRAITEMENT','PRESTATION')
  AND NOT EXISTS (SELECT 1 FROM public.article_subcontract_definition sd WHERE sd.article_id=a.id)
  AND NOT EXISTS (SELECT 1 FROM public.articles_traitement tr WHERE tr.article_id=a.id)
  AND NOT EXISTS (SELECT 1 FROM unnest(cl.documents_attendus) AS expected(document)
    WHERE upper(trim(document)) NOT IN ('','BL','BON_LIVRAISON'))
  AND NOT EXISTS (SELECT 1 FROM public.quality_control qc WHERE (qc.lot_id=lot.id OR (qc.source_type='LOT' AND qc.source_id=lot.id::text))
    AND qc.status::text <> 'CANCELLED')
  AND NOT EXISTS (SELECT 1 FROM public.non_conformity nc WHERE nc.lot_id=lot.id AND nc.status::text NOT IN ('CLOSED','CANCELLED'))
  AND NOT EXISTS (SELECT 1 FROM public.quality_control_plan plan
    LEFT JOIN public.pieces_techniques part ON part.id=a.piece_technique_id
    WHERE plan.trigger_type='RECEPTION' AND plan.status='PUBLISHED'
      AND (plan.effective_from IS NULL OR plan.effective_from<=now()) AND (plan.effective_to IS NULL OR plan.effective_to>=now())
      AND (plan.article_id IS NULL OR plan.article_id=a.id)
      AND (plan.piece_technique_id IS NULL OR plan.piece_technique_id=part.id)
      AND (plan.famille_id IS NULL OR plan.famille_id=part.famille_id)
      AND (plan.fournisseur_id IS NULL OR plan.fournisseur_id=r.fournisseur_id)
      AND plan.piece_version_id IS NULL AND plan.operation_code IS NULL
      AND (plan.article_id IS NOT NULL OR plan.piece_technique_id IS NOT NULL OR plan.famille_id IS NOT NULL))
  THEN 'MP' END`;
