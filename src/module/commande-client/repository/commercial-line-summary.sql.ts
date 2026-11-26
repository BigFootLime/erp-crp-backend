export type CommercialLineSummary = {
  items: Array<{ reference: string | null; indice: string | null; designation: string | null }>;
  total: number;
};

const ORDER_LINE_IDENTITY_SQL = `
  SELECT l.id, l.id AS line_order,
    COALESCE(NULLIF(btrim(v.plan_reference), ''), NULLIF(btrim(l.code_piece), ''),
      NULLIF(btrim(ar.code), ''), NULLIF(btrim(pt.code_piece), '')) AS reference,
    COALESCE(NULLIF(btrim(v.indice_externe_original), ''), NULLIF(btrim(v.indice), '')) AS indice,
    NULLIF(btrim(l.designation), '') AS designation
  FROM public.commande_ligne l
  LEFT JOIN public.piece_technique_versions v ON v.id = l.piece_technique_version_id
  LEFT JOIN public.articles ar ON ar.id = l.article_id
  LEFT JOIN public.pieces_techniques pt ON pt.id = COALESCE(v.piece_technique_id, l.piece_technique_id, ar.piece_technique_id)
`;

function commercialLineSummaryJoin(linesSql: string) {
  return `
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'total', COUNT(*)::int,
        'items', COALESCE(
          jsonb_agg(jsonb_build_object('reference', reference, 'indice', indice, 'designation', designation)
                    ORDER BY line_order, id) FILTER (WHERE position <= 3), '[]'::jsonb
        )
      ) AS line_summary
      FROM (
        SELECT lines.*, row_number() OVER (ORDER BY lines.line_order, lines.id) AS position
        FROM (${linesSql}) lines
      ) preview
    ) commercial_lines ON TRUE
  `;
}

export const COMMANDE_LINE_SUMMARY_JOIN_SQL = commercialLineSummaryJoin(`
  ${ORDER_LINE_IDENTITY_SQL}
  WHERE l.commande_id = page.id::bigint
`);

export const AFFAIRE_LINE_SUMMARY_JOIN_SQL = commercialLineSummaryJoin(`
  ${ORDER_LINE_IDENTITY_SQL}
  WHERE l.commande_id = page.commande_id::bigint
    AND (
      EXISTS (
        SELECT 1 FROM public.commande_ligne_affaire_allocation al
        WHERE al.commande_ligne_id = l.id
          AND (al.livraison_affaire_id = page.id::bigint OR al.production_affaire_id = page.id::bigint)
      ) OR NOT EXISTS (
        SELECT 1 FROM public.commande_ligne_affaire_allocation al
        WHERE al.commande_id = l.commande_id
      )
    )

  UNION ALL

  SELECT dl.id, COALESCE(dl.position, dl.id) AS line_order,
    COALESCE(NULLIF(btrim(dd.payload->>'plan_reference'), ''), NULLIF(btrim(to_jsonb(dl)->>'code_piece'), ''),
      NULLIF(btrim(dd.code_piece), ''), NULLIF(btrim(ad.code), ''), NULLIF(btrim(ar.code), ''),
      NULLIF(btrim(pt.code_piece), '')) AS reference,
    NULLIF(btrim(dd.payload->>'indice_externe'), '') AS indice,
    NULLIF(btrim(dl.description), '') AS designation
  FROM public.devis_ligne dl
  LEFT JOIN public.article_devis ad ON ad.devis_ligne_id = dl.id
  LEFT JOIN public.dossier_technique_piece_devis dd ON dd.article_devis_id = ad.id
  LEFT JOIN public.articles ar ON ar.id = dl.article_id
  LEFT JOIN public.pieces_techniques pt ON pt.id = COALESCE(dl.piece_technique_id, ar.piece_technique_id, dd.source_official_piece_technique_id)
  WHERE page.commande_id IS NULL AND dl.devis_id = page.devis_id::bigint
`);
