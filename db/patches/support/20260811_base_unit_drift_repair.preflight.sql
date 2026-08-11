-- Read-only preflight for the canonical base-unit repair.

SELECT
  to_regclass('public.units') IS NOT NULL AS units_present,
  (SELECT count(*) FROM public.units WHERE lower(code::text) = 'u') <= 1
    AS no_case_insensitive_duplicate,
  EXISTS (SELECT 1 FROM public.cerp_schema_migrations
    WHERE filename = '20260223_seed_currencies_units.sql')
    AS historical_seed_recorded,
  EXISTS (SELECT 1 FROM public.units WHERE lower(code::text) = 'u')
    AS base_unit_currently_present;
