/** One PostgreSQL statement = one MVCC snapshot for physical quantities,
 * projection lag and monetary proofs. No physical locks or free monetary input. */
export const CUMP_ARTICLE_COVERAGE_SQL = `
WITH article AS (SELECT id,code,designation FROM public.articles WHERE id=$1::uuid),
physical AS (
  SELECT s.id::text AS id,s.id::text AS stock_level_id,NULL::text AS stock_batch_id,s.article_id::text,
    true AS source_valid,jsonb_build_object('schema_version',1,'kind','LEVEL','article_id',s.article_id::text,
      'stock_level_id',s.id::text,'stock_batch_id',NULL,'stock_unit',COALESCE(u.code,a.unite),
      'quantity_total',s.qty_total::text,'quantity_depreciated',s.qty_depreciated::text,
      'quantity_reserved',s.qty_reserved::text,'owner_client_id',NULL) AS source_snapshot
  FROM public.stock_levels s JOIN public.articles a ON a.id=s.article_id LEFT JOIN public.units u ON u.id=s.unit_id
  WHERE s.article_id=$1::uuid
  UNION ALL
  SELECT b.id::text,s.id::text,b.id::text,s.article_id::text,(l.id IS NOT NULL),
    jsonb_build_object('schema_version',1,'kind','BATCH','article_id',s.article_id::text,
      'stock_level_id',s.id::text,'stock_batch_id',b.id::text,'stock_unit',COALESCE(u.code,a.unite),
      'quantity_total',b.qty_total::text,'quantity_depreciated',b.qty_depreciated::text,
      'quantity_reserved',b.qty_reserved::text,'owner_client_id',l.client_proprietaire_id)
  FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id
    JOIN public.articles a ON a.id=s.article_id LEFT JOIN public.units u ON u.id=s.unit_id LEFT JOIN public.lots l ON l.id=b.lot_id
  WHERE s.article_id=$1::uuid
), bounded_physical AS (SELECT * FROM physical ORDER BY stock_level_id,stock_batch_id NULLS FIRST LIMIT 10001),
projected AS (
  SELECT b.article_id::text,b.owner_key,b.stock_unit,b.currency,b.quantity::text,b.value::text,b.reliability,b.source_ref,
    b.latest_sequence::text,b.latest_entry_id::text,
    e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
      AND (e.article_id,e.owner_key,e.stock_unit,e.currency) IS NOT DISTINCT FROM (b.article_id,b.owner_key,b.stock_unit,b.currency)
      AND COALESCE(e.source_sequence,0)=b.latest_sequence
      AND(e.source_snapshot->'after_state'->>'quantity')::numeric=b.quantity
      AND(e.source_snapshot->'after_state'->>'value')::numeric IS NOT DISTINCT FROM b.value
      AND e.source_snapshot->'after_state'->>'reliability'=b.reliability
      AND e.source_snapshot->'after_state'->>'sourceRef' IS NOT DISTINCT FROM b.source_ref
      AND(e.movement_id IS NULL OR(e.source_snapshot->>'stock_source_sha256'=j.source_sha256
        AND j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex'))) AS source_valid
  FROM public.stock_valuation_balances b LEFT JOIN public.stock_valuation_entries e ON e.id=b.latest_entry_id
    LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.movement_id
  WHERE b.article_id=$1::uuid ORDER BY b.owner_key,b.stock_unit,b.currency LIMIT 1001
)
SELECT a.id::text AS article_id,a.code,a.designation,statement_timestamp()::text AS observed_at,
  c.mode,c.initialized,c.reporting_currency,c.formula_version,c.last_sequence::text,
  (SELECT count(*)::text FROM public.stock_valuation_movement_journal j
    WHERE j.article_id=a.id AND j.sequence>c.last_sequence) AS pending_movements,
  EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.article_id=a.id
    AND(e.kind='UNRESOLVED' OR e.source_snapshot->'blocking'='true'::jsonb)) AS blocked,
  EXISTS(SELECT 1 FROM public.stock_movements m CROSS JOIN public.stock_valuation_capture_boundary boundary
    WHERE m.article_id=a.id AND m.status::text IN('POSTED','COMPENSATED')
      AND(m.posted_at>=boundary.started_at OR m.created_at>=boundary.started_at)
      AND NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=m.id)) AS capture_missing,
  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM bounded_physical p),'[]'::jsonb) AS physical,
  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM projected p),'[]'::jsonb) AS projected
FROM article a CROSS JOIN public.stock_valuation_projector_control c WHERE c.singleton`;
