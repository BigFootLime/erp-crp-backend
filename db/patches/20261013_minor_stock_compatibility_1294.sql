-- Approved, non-impacting minor revisions are interchangeable in both directions.
-- Stock retains its real version; this view never rewrites lots or frozen orders.
CREATE OR REPLACE VIEW public.v_technical_stock_compatibility_832 AS
WITH RECURSIVE approved_links AS (
  SELECT newer.id AS newer_id, older.id AS older_id
  FROM public.piece_technique_versions newer
  JOIN public.piece_technique_versions older ON older.id = newer.copied_from_version_id
  WHERE newer.change_level = 'MINOR'
    AND newer.impact_interchangeabilite = false
    AND newer.statut IN ('APPLICABLE', 'OBSOLETE')
    AND older.statut IN ('APPLICABLE', 'OBSOLETE')
    AND newer.piece_technique_id = older.piece_technique_id
    AND upper(btrim(newer.indice)) = upper(btrim(older.indice))
), edges(source_id, destination_id) AS (
  SELECT newer_id, older_id FROM approved_links
  UNION ALL
  SELECT older_id, newer_id FROM approved_links
), compatible(target_version_id, stock_version_id) AS (
  SELECT id, id FROM public.piece_technique_versions
  WHERE statut IN ('APPLICABLE', 'OBSOLETE')
  UNION
  -- UNION deduplicates pairs and terminates even if historical links contain a cycle.
  SELECT compatible.target_version_id, edges.destination_id
  FROM compatible
  JOIN edges ON edges.source_id = compatible.stock_version_id
)
SELECT target_version_id, stock_version_id FROM compatible;

GRANT SELECT ON public.v_technical_stock_compatibility_832 TO cerp_app;
