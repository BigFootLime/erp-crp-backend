/** These SQL fragments receive repository-owned aliases, never request values. */
export function receiptArticleContextSql(articleAlias:string,ownerSql?:string){
  const owner=ownerSql??`(SELECT client_proprietaire_id FROM public.articles_matiere WHERE article_id=${articleAlias}.id)`;
  return `jsonb_build_object(
    'ownerClientId',${owner},
    'ownerClientName',(SELECT company_name FROM public.clients WHERE client_id=${owner}),
    'material',(SELECT jsonb_build_object('profile',m.family_code,'barToCut',m.barre_a_decouper,
      'sourceLengthMm',m.longueur_barre_source_mm,'cutLengthMm',m.longueur_coupe_mm,'blankLengthMm',m.longueur_brut_mm,
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
