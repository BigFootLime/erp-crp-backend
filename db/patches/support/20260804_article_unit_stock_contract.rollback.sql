-- #475 guarded rollback. Manual only; never rewrites article or stock history.
-- Removes only unit rows proven to have been introduced by this patch.

BEGIN;

DO $$
DECLARE seeded record;
BEGIN
  IF current_database() = 'cerp_prod' THEN
    RAISE EXCEPTION '#475 rollback is refused on cerp_prod';
  END IF;

  FOR seeded IN
    SELECT code, unit_id FROM public.cerp_patch_20260804_stock_units
    WHERE inserted_by_patch = true
  LOOP
    IF EXISTS (
      SELECT 1 FROM public.articles
      WHERE lower(btrim(unite)) = seeded.code
    ) THEN
      RAISE EXCEPTION '#475 rollback refused: articles reference unit %', seeded.code;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.stock_levels sl
      WHERE sl.unit_id::text = seeded.unit_id
    ) THEN
      RAISE EXCEPTION '#475 rollback refused: stock levels reference unit %', seeded.code;
    END IF;

    DELETE FROM public.units
    WHERE id::text = seeded.unit_id
      AND lower(code::text) = seeded.code;
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.cerp_patch_20260804_stock_units;

COMMIT;
