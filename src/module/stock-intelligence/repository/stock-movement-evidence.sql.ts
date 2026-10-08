/** Prices are recorded movement evidence, not a materialized CUMP ledger. */
export const STOCK_MOVEMENT_EVIDENCE_SQL = `WITH movement_cost AS (
  SELECT movement.id,movement.article_id,movement.stock_level_id,movement.movement_type::text AS movement_type,
         movement.effective_at,movement.updated_at,movement.doc_type,
         movement.qty::float8 AS movement_qty,
         COALESCE(unit.code::text,article.unite) AS cost_stock_unit,
         count(line.id)>0 AND bool_and((
           line.article_id=movement.article_id
           AND NULLIF(lower(btrim(line.unite)),'')=NULLIF(lower(btrim(COALESCE(unit.code::text,article.unite))),'')
         ) IS TRUE) AS unit_compatible,
         CASE WHEN count(line.id)>0 AND count(line.unit_cost)=count(line.id)
               AND bool_and(line.unit_cost>=0)
               AND count(DISTINCT NULLIF(upper(btrim(line.currency)),''))=1
               AND count(NULLIF(btrim(line.currency),''))=count(line.id)
               AND bool_and(upper(btrim(line.currency)) ~ '^[A-Z]{3}$')
               AND bool_and((line.article_id=movement.article_id
                 AND NULLIF(lower(btrim(line.unite)),'')=NULLIF(lower(btrim(COALESCE(unit.code::text,article.unite))),'')) IS TRUE)
               AND sum(abs(line.qty))=abs(movement.qty)
              THEN sum(abs(line.qty)*line.unit_cost)::float8 ELSE NULL END AS movement_value,
         CASE WHEN count(line.id)>0 AND count(line.unit_cost)=count(line.id)
               AND bool_and(line.unit_cost>=0)
               AND count(DISTINCT NULLIF(upper(btrim(line.currency)),''))=1
               AND count(NULLIF(btrim(line.currency),''))=count(line.id)
               AND bool_and(upper(btrim(line.currency)) ~ '^[A-Z]{3}$')
               AND bool_and((line.article_id=movement.article_id
                 AND NULLIF(lower(btrim(line.unite)),'')=NULLIF(lower(btrim(COALESCE(unit.code::text,article.unite))),'')) IS TRUE)
               AND sum(abs(line.qty))=abs(movement.qty)
              THEN (sum(abs(line.qty)*line.unit_cost)/NULLIF(sum(abs(line.qty)),0))::float8 ELSE NULL END AS unit_cost,
         CASE WHEN count(DISTINCT NULLIF(upper(btrim(line.currency)),''))=1
               AND count(NULLIF(btrim(line.currency),''))=count(line.id)
              THEN min(NULLIF(upper(btrim(line.currency)),'')) ELSE NULL END AS currency
    FROM public.stock_movements movement
    JOIN public.stock_levels level ON level.id=movement.stock_level_id
    JOIN public.articles article ON article.id=movement.article_id
    LEFT JOIN public.units unit ON unit.id=level.unit_id
    LEFT JOIN public.stock_movement_lines line ON line.movement_id=movement.id
   WHERE movement.status::text='POSTED' AND movement.effective_at::date <= $1::date
   GROUP BY movement.id,unit.code,article.unite
), scoped AS (
  SELECT concat(cost.article_id::text,':',COALESCE(magasin.id::text,'-')) AS key,cost.*
    FROM movement_cost cost
    JOIN public.stock_levels level ON level.id=cost.stock_level_id
    LEFT JOIN public.emplacements emplacement ON emplacement.location_id=level.location_id
    LEFT JOIN public.magasins magasin ON magasin.id=emplacement.magasin_id
   WHERE ($4::uuid IS NULL OR cost.article_id=$4::uuid)
     AND ($5::uuid IS NULL OR magasin.id=$5::uuid)
     AND COALESCE(cost.doc_type,'') <> 'STOCK_TRANSFER_INTERNAL'
), ranked AS (
  SELECT scoped.*,max(effective_at) OVER(PARTITION BY key) AS newest_effective_at FROM scoped
)
SELECT key,
       COALESCE(sum(abs(movement_qty)) FILTER (
         WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
       ),0)::float8 AS outbound_qty_abc,
       CASE WHEN count(*) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int AND movement_value IS NULL
            )=0 AND count(DISTINCT currency) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
            )<=1
            THEN COALESCE(sum(movement_value) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
            ),0)::float8 ELSE NULL END AS outbound_value_abc,
       CASE WHEN count(DISTINCT currency) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
            )=1 THEN min(currency) FILTER (
              WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int
            ) ELSE NULL END AS outbound_currency,
       COALESCE(sum(abs(movement_qty)) FILTER (
         WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$3::int
       ),0)::float8 AS outbound_qty_coverage,
       (max(effective_at) FILTER (WHERE movement_type IN ('OUT','SCRAP')))::text AS last_outbound_at,
       (array_agg(unit_cost ORDER BY effective_at DESC,id DESC))[1]::float8 AS latest_applied_unit_cost,
       (array_agg(currency ORDER BY effective_at DESC,id DESC))[1]::text AS cost_currency,
       (array_agg(unit_compatible ORDER BY effective_at DESC,id DESC))[1] AS latest_unit_compatible,
       (array_agg(cost_stock_unit ORDER BY effective_at DESC,id DESC))[1] AS latest_stock_unit,
       count(*) FILTER (WHERE effective_at=newest_effective_at)>1 AS latest_order_ambiguous,
       (array_agg(id::text ORDER BY effective_at DESC,id DESC))[1] AS latest_movement_id,
       count(*) FILTER (
         WHERE movement_type IN ('OUT','SCRAP') AND effective_at::date > $1::date-$2::int AND movement_value IS NULL
       )::int AS unpriced_movement_count,
       count(DISTINCT currency)::int AS currency_count,
       max(updated_at)::text AS freshness_at
  FROM ranked GROUP BY key`;
