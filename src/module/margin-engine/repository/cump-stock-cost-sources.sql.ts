import { OF_MARGIN_MATERIAL_SOURCES_SQL } from './of-margin-sources.sql';
import { OF_MARGIN_CONSUMABLE_SOURCES_SQL } from './consumable-cost-sources.sql';
import { OF_MARGIN_ASSEMBLY_COMPONENT_SOURCES_SQL } from './assembly-component-cost-sources.sql';

/** Physical attribution and financial evidence must share one database snapshot.
 * Original immutable issue amounts are historical facts, not a current unit
 * price multiplied by a former quantity. No locks, financial writes or FX. */
export const OF_MARGIN_CUMP_STOCK_SOURCES_SQL = `
WITH sources AS (
  SELECT to_jsonb(material) AS cost FROM (${OF_MARGIN_MATERIAL_SOURCES_SQL}) material
  UNION ALL SELECT to_jsonb(consumable) FROM (${OF_MARGIN_CONSUMABLE_SOURCES_SQL}) consumable
  UNION ALL SELECT to_jsonb(component) FROM (${OF_MARGIN_ASSEMBLY_COMPONENT_SOURCES_SQL}) component
), bounded AS (SELECT * FROM sources ORDER BY cost->>'key' LIMIT 10001)
SELECT s.cost,c.mode,c.initialized,c.reporting_currency,c.formula_version,c.last_sequence::text,
  CASE WHEN j.movement_id IS NULL THEN NULL ELSE jsonb_build_object(
    'sequence',j.sequence::text,'movement_id',j.movement_id::text,'article_id',j.article_id::text,
    'source_snapshot',j.source_snapshot,'source_sha256',j.source_sha256,
    'source_valid',j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex'),
    'acquisition_snapshot',NULL,'acquisition_sha256',NULL,'acquisition_valid',NULL) END AS journal,
  EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal pending
    WHERE pending.article_id=j.article_id AND pending.sequence>c.last_sequence) AS article_pending,
  EXISTS(SELECT 1 FROM public.stock_valuation_entries blocked WHERE blocked.article_id=j.article_id
    AND(blocked.kind='UNRESOLVED' OR blocked.source_snapshot->'blocking'='true'::jsonb)) AS article_blocked,
  COALESCE((SELECT jsonb_agg(to_jsonb(entry)) FROM (
    SELECT e.id::text AS entry_id,e.article_id::text,e.owner_key,e.stock_unit,e.currency,e.kind,
      e.source_sequence::text AS sequence,e.formula_version,e.quantity_delta::text,e.movement_value::text,e.reliability,e.source_snapshot,
      e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
        AND e.source_snapshot->>'stock_source_sha256'=j.source_sha256 AS source_valid
    FROM public.stock_valuation_entries e WHERE e.movement_id=j.movement_id ORDER BY e.id LIMIT 3
  ) entry),'[]'::jsonb) AS entries,
  COALESCE((SELECT jsonb_agg(to_jsonb(cursor)) FROM (
    SELECT r.original_entry_id::text,r.owner_key,r.stock_unit,r.currency,r.quantity::text,r.value::text,
      e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
        AND e.original_entry_id=r.original_entry_id AND e.original_movement_id=r.original_movement_id
        AND(e.owner_key,e.stock_unit,e.currency) IS NOT DISTINCT FROM(r.owner_key,r.stock_unit,r.currency)
        AND(e.source_snapshot->'after_cursor'->>'quantity')::numeric=r.quantity
        AND(e.source_snapshot->'after_cursor'->>'value')::numeric IS NOT DISTINCT FROM r.value AS source_valid
    FROM public.stock_valuation_return_allocations r
    LEFT JOIN public.stock_valuation_return_allocation_events e ON e.id=r.latest_event_id
    WHERE r.original_movement_id=j.movement_id ORDER BY r.owner_key,r.stock_unit,r.currency LIMIT 3
  ) cursor),'[]'::jsonb) AS returns
FROM bounded s CROSS JOIN public.stock_valuation_projector_control c
LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=(s.cost->>'source_ref')::uuid
WHERE c.singleton ORDER BY s.cost->>'key'`;
