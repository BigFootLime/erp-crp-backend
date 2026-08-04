-- #475 guarded rollback. Manual only; never rewrites article or stock history.
-- It removes the seeded code only when no article or stock level references it.

BEGIN;

DO $$
BEGIN
  IF current_database() = 'cerp_prod' THEN
    RAISE EXCEPTION '#475 rollback is refused on cerp_prod';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.cerp_patch_20260804_unit_mm WHERE singleton = true AND inserted_by_patch = true
  ) THEN
    RAISE NOTICE '#475 rollback: mm existed before this patch; nothing to remove.';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.articles WHERE unite = 'mm') THEN
    RAISE EXCEPTION '#475 rollback refused: articles still reference unit mm';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stock_levels sl
    JOIN public.units u ON u.id = sl.unit_id
    WHERE u.code = 'mm'
  ) THEN
    RAISE EXCEPTION '#475 rollback refused: stock levels still reference unit mm';
  END IF;

  DELETE FROM public.units WHERE code = 'mm';
  DELETE FROM public.cerp_patch_20260804_unit_mm WHERE singleton = true;
END $$;

DROP TABLE IF EXISTS public.cerp_patch_20260804_unit_mm;

COMMIT;
