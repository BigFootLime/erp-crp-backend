/** One SQL statement gives a coherent view of the selected technical revision. */
export const TECHNICAL_SHEET_SOURCE_SQL = `
SELECT jsonb_build_object(
  'piece', jsonb_build_object('id',p.id,'code',p.code_piece,'designation',p.designation,
    'designation_2',p.designation_2,'client_code',p.code_client,'client_name',p.client_name,
    'critical',p.piece_critique,'quality_levels',p.quality_levels),
  'version',to_jsonb(v),
  'gamme',CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object('code',g.code,'designation',g.designation,'statut',g.statut) END,
  'operations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'phase',op.phase,'designation',op.designation,'type',op.type_operation,
    'machine',COALESCE(m.display_name,m.name),'family',op.machine_family_code,
    'centre',cf.code,'programme',op.numero_programme,'reglage_h',op.tp,'piece_h',op.tf_unit,
    'base_qty',op.qte,'consignes',op.consignes) ORDER BY op.phase,op.id)
    FROM public.pieces_techniques_operations op
    LEFT JOIN public.machines m ON m.id=op.machine_id
    LEFT JOIN public.centres_frais cf ON cf.id=op.cf_id
    WHERE op.piece_technique_id=p.id AND
      (op.gamme_id=g.id OR (g.id IS NULL AND op.gamme_id IS NULL AND NOT EXISTS(
        SELECT 1 FROM public.gammes scoped JOIN public.piece_technique_versions sv ON sv.id=scoped.piece_technique_version_id
          WHERE sv.piece_technique_id=p.id)))), '[]'::jsonb),
  'nomenclature',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'repere',n.repere,'reference',COALESCE(cv.code_metier,child.code_piece,a.code),
    'designation',COALESCE(child.designation,a.designation),'indice',cv.indice,
    'version',cv.version_interne,'qty',n.quantite,'scope',CASE WHEN n.parent_piece_technique_version_id IS NULL THEN 'Héritée' ELSE 'Version' END)
    ORDER BY n.rang,n.id)
    FROM public.pieces_techniques_nomenclature n
    LEFT JOIN public.pieces_techniques child ON child.id=n.child_piece_technique_id
    LEFT JOIN public.piece_technique_versions cv ON cv.id=n.child_piece_technique_version_id
    LEFT JOIN public.articles a ON a.id=n.child_article_id
    WHERE n.parent_piece_technique_id=p.id AND (n.parent_piece_technique_version_id=v.id OR
      (n.parent_piece_technique_version_id IS NULL AND NOT EXISTS(
        SELECT 1 FROM public.pieces_techniques_nomenclature scoped WHERE scoped.parent_piece_technique_id=p.id
          AND scoped.parent_piece_technique_version_id IS NOT NULL)))), '[]'::jsonb),
  'achats',COALESCE((SELECT jsonb_agg(jsonb_build_object('phase',pa.phase,'type',pa.type_achat,
    'reference',COALESCE(a.code,pa.nom),'designation',pa.designation,'qty',pa.quantite,
    'pieces',pa.quantite_pieces,'longueur_mm',pa.longueur_mm,'brut_mm',pa.quantite_brut_mm,
    'supplier',pa.fournisseur_nom,'scope',CASE WHEN pa.piece_technique_version_id IS NULL THEN 'Hérité' ELSE 'Version' END)
    ORDER BY pa.phase NULLS LAST,pa.id)
    FROM public.pieces_techniques_achats pa LEFT JOIN public.articles a ON a.id=pa.article_id
    WHERE pa.piece_technique_id=p.id AND (pa.piece_technique_version_id=v.id OR
      (pa.piece_technique_version_id IS NULL AND NOT EXISTS(
        SELECT 1 FROM public.pieces_techniques_achats scoped WHERE scoped.piece_technique_id=p.id
          AND scoped.piece_technique_version_id IS NOT NULL)))), '[]'::jsonb),
  'requirements',COALESCE((SELECT jsonb_agg(jsonb_build_object('label',r.document_type_label,
    'policy',r.policy,'critical',r.piece_critique) ORDER BY r.document_type_code)
    FROM public.piece_version_document_requirements r WHERE r.piece_technique_version_id=v.id), '[]'::jsonb),
  'documents',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',l.link_role,'title',d.title,
    'version_id',dv.id,'version',dv.version_number,'status',dv.status,'sha256',b.sha256)
    ORDER BY l.link_role,d.id)
    FROM public.ged_document_links l JOIN public.ged_documents d ON d.id=l.document_id AND d.archived_at IS NULL
    JOIN public.ged_document_versions dv ON dv.id=d.current_version_id
    JOIN public.ged_blobs b ON b.id=dv.blob_id
    WHERE l.entity_type='PIECE_TECHNIQUE_VERSION' AND l.entity_id=v.id::text
      AND l.link_role<>'AUTHORITATIVE_PDF'), '[]'::jsonb)
) AS source
FROM public.pieces_techniques p JOIN public.piece_technique_versions v ON v.piece_technique_id=p.id
LEFT JOIN public.gammes g ON g.piece_technique_version_id=v.id AND g.is_current=true
WHERE p.id=$1::uuid AND v.id=$2::uuid AND p.deleted_at IS NULL
`;
