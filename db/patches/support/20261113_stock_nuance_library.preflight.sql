-- Read-only; compatible with the pre-library schema. Review every returned row.
WITH normalized_codes AS (
  SELECT id, code, regexp_replace(translate(upper(code), 'ÀÂÄÁÃÅÇÈÉÊËÌÍÎÏÑÒÓÔÖÕÙÚÛÜÝŸ', 'AAAAAACEEEEIIIINOOOOOUUUUYY'), '[^A-Z0-9]', '', 'g') AS normalized
  FROM public.stock_nuances
)
SELECT array_agg(id ORDER BY id) AS ids, array_agg(code ORDER BY id) AS codes, normalized
FROM normalized_codes GROUP BY normalized HAVING count(*) > 1 OR normalized = '';
SELECT count(*) AS historical_nuances, count(*) FILTER (WHERE NOT is_active) AS inactive_nuances FROM public.stock_nuances;
SELECT count(*) AS article_links FROM public.articles_matiere WHERE nuance_id IS NOT NULL;
