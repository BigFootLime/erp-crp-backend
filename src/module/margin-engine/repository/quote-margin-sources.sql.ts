// The quote/article schema holds a PT identity, not a pinned version. Capture
// the same current dossier used by the PT screens and record its version ID.
export const QUOTE_MARGIN_SOURCES_SQL = `
  WITH lines AS (
    SELECT dl.id,dl.quantite,COALESCE(dl.piece_technique_id,ar.piece_technique_id) AS piece_id,
      version.id AS version_id
    FROM public.devis_ligne dl LEFT JOIN public.articles ar ON ar.id=dl.article_id
    LEFT JOIN LATERAL (
      SELECT v.id FROM public.piece_technique_versions v
      WHERE v.piece_technique_id=COALESCE(dl.piece_technique_id,ar.piece_technique_id)
        AND v.statut<>'OBSOLETE'
      ORDER BY CASE WHEN v.statut='APPLICABLE' THEN 0 ELSE 1 END,
        v.version_interne DESC NULLS LAST,v.created_at DESC,v.id DESC LIMIT 1
    ) version ON true
    WHERE ($2::text='DEVIS_LINE' AND dl.id=$1::bigint) OR ($2::text='DEVIS' AND dl.devis_id=$1::bigint)
  ), dossiers AS (
    SELECT lines.*,gamme.id AS gamme_id FROM lines
    LEFT JOIN LATERAL (
      SELECT g.id FROM public.gammes g WHERE g.piece_technique_version_id=lines.version_id AND g.statut<>'OBSOLETE'
      ORDER BY g.is_current DESC,CASE WHEN g.statut='APPLICABLE' THEN 0 ELSE 1 END,g.updated_at DESC,g.id DESC LIMIT 1
    ) gamme ON true
  )
  SELECT concat('quote-line:',dl.id,':purchase:',a.id) AS key,
    CASE WHEN a.type_achat='MATIERE' THEN 'MATERIAL'
      WHEN a.type_achat IN ('SOUS_TRAITANCE','TRAITEMENT') THEN 'SUBCONTRACTING' ELSE 'PURCHASE' END::text AS category,
    round(a.total_achat_ht*dl.quantite,6)::text AS amount_ht,
    'PIECE_TECHNIQUE_ACHAT'::text AS source_type,a.id::text AS source_ref,a.updated_at::text AS observed_at,
    dl.quantite::text AS quantity,dl.version_id::text AS technical_version_id
  FROM dossiers dl JOIN public.pieces_techniques_achats a ON a.piece_technique_id=dl.piece_id
  WHERE a.piece_technique_version_id=dl.version_id OR (a.piece_technique_version_id IS NULL AND NOT EXISTS(
    SELECT 1 FROM public.pieces_techniques_achats versioned WHERE versioned.piece_technique_id=dl.piece_id AND versioned.piece_technique_version_id IS NOT NULL))
  UNION ALL
  SELECT concat('quote-line:',dl.id,':operation:',op.id) AS key,
    CASE WHEN op.type_operation='CONTROLE' THEN 'CONTROL' WHEN op.type_operation='EMBALLAGE' THEN 'PACKAGING'
      WHEN op.type_operation='SOUS_TRAITANCE' THEN 'SUBCONTRACTING' ELSE 'OPERATOR' END::text AS category,
    CASE WHEN op.taux_horaire>0 AND op.tp>=0 AND op.tf_unit>=0 AND op.coef>0
      THEN round((op.tp+op.tf_unit*dl.quantite)*op.coef*op.taux_horaire,6)::text ELSE NULL END AS amount_ht,
    'PIECE_TECHNIQUE_OPERATION'::text AS source_type,op.id::text AS source_ref,op.updated_at::text AS observed_at,
    dl.quantite::text AS quantity,dl.version_id::text AS technical_version_id
  FROM dossiers dl JOIN public.pieces_techniques_operations op ON op.piece_technique_id=dl.piece_id
  WHERE op.gamme_id=dl.gamme_id OR (op.gamme_id IS NULL AND dl.gamme_id IS NULL AND NOT EXISTS(
    SELECT 1 FROM public.gammes historical JOIN public.piece_technique_versions v ON v.id=historical.piece_technique_version_id
    WHERE v.piece_technique_id=dl.piece_id))
  ORDER BY key
`;
