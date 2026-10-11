// Match the selected OF definition: legacy purchases are a fallback only when
// that exact version has no purchases. Keep distinct source lines and paths.
export const ASSEMBLY_PURCHASED_REQUIREMENTS_SQL = `SELECT line.id::text AS source_line_id,
            line.parent_piece_technique_id::text AS piece_technique_id,
            line.parent_piece_technique_version_id::text AS parent_piece_technique_version_id,
            article.id::text AS article_id,
            article.code AS article_code,
            COALESCE(line.designation, article.designation) AS designation,
            line.quantite::float8 AS quantity_per_parent,
            'BOM'::text AS source_kind
       FROM public.pieces_techniques_nomenclature line
       JOIN public.articles article ON article.id = line.child_article_id
      WHERE line.parent_piece_technique_id = ANY($1::uuid[])
        AND line.child_article_id IS NOT NULL
      UNION ALL
     SELECT purchase.id::text AS source_line_id,
            purchase.piece_technique_id::text AS piece_technique_id,
            wanted.version_id::text AS parent_piece_technique_version_id,
            article.id::text AS article_id,
            article.code AS article_code,
            COALESCE(purchase.nom, article.designation) AS designation,
            purchase.quantite::float8 AS quantity_per_parent,
            'PURCHASE'::text AS source_kind
       FROM public.pieces_techniques_achats purchase
       JOIN (SELECT DISTINCT piece_id, version_id FROM unnest($1::uuid[], $2::uuid[]) AS selection(piece_id, version_id)) wanted
         ON wanted.piece_id = purchase.piece_technique_id
       JOIN public.articles article ON article.id = purchase.article_id
      WHERE purchase.piece_technique_id = ANY($1::uuid[])
        AND purchase.article_id IS NOT NULL
        AND (purchase.piece_technique_version_id = wanted.version_id
          OR (purchase.piece_technique_version_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM public.pieces_techniques_achats scoped
             WHERE scoped.piece_technique_id = wanted.piece_id
               AND scoped.piece_technique_version_id = wanted.version_id
          )))
      ORDER BY piece_technique_id, parent_piece_technique_version_id NULLS FIRST, source_kind, source_line_id`;
