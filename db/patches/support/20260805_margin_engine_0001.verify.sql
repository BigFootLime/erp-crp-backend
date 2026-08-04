-- Lecture seule. Toutes les colonnes *_append_only doivent etre vraies.
SELECT
  to_regclass('public.margin_rate_versions') IS NOT NULL AS rate_versions_ready,
  to_regclass('public.margin_rates') IS NOT NULL AS rates_ready,
  to_regclass('public.margin_input_versions') IS NOT NULL AS inputs_ready,
  to_regclass('public.margin_recalculations') IS NOT NULL AS recalculations_ready;

SELECT
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_margin_rate_versions_append_only' AND NOT tgisinternal) AS rate_versions_append_only,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_margin_rates_append_only' AND NOT tgisinternal) AS rates_append_only,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_margin_input_versions_append_only' AND NOT tgisinternal) AS inputs_append_only,
  EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_margin_recalculations_append_only' AND NOT tgisinternal) AS recalculations_append_only;

SELECT scope_type, basis, count(*) AS version_count
FROM public.margin_input_versions
GROUP BY scope_type, basis
ORDER BY scope_type, basis;
