-- Read-only verification for the canonical base-unit repair. Every boolean must be true.

SELECT
  (SELECT count(*) FROM public.units WHERE lower(code::text) = 'u') = 1
    AS one_canonical_base_unit,
  EXISTS (
    SELECT 1
    FROM public.cerp_patch_20260811_base_unit_repair marker
    JOIN public.units unit
      ON unit.id::text = marker.unit_id
     AND lower(unit.code::text) = marker.code
    WHERE marker.code = 'u'
  ) AS provenance_matches_unit;
