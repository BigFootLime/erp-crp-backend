-- #475 / BUG-CERP-0013 — Canonical article/stock unit contract.
--
-- `public.units.code` is the sole referential used by stock movements and is
-- now also validated when an article is created or updated. Existing article
-- values are never rewritten: this additive seed makes the already accepted
-- linear unit `mm` resolvable by the stock ledger.
--
-- Idempotent. Run the companion preflight/verify scripts manually on cerp_test;
-- do not run this patch against production as part of this change.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.units') IS NULL THEN
    RAISE EXCEPTION '#475: public.units is required before adding the mm unit';
  END IF;
END $$;

-- Keep whether this patch introduced `mm`: rollback must never delete a unit
-- that predated the patch. This tiny marker is dropped by the guarded rollback.
CREATE TABLE IF NOT EXISTS public.cerp_patch_20260804_unit_mm (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  inserted_by_patch boolean NOT NULL
);

DO $$
DECLARE introduced boolean;
BEGIN
  SELECT inserted_by_patch INTO introduced
  FROM public.cerp_patch_20260804_unit_mm
  WHERE singleton = true;

  IF introduced IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.units WHERE code = 'mm') THEN
      INSERT INTO public.cerp_patch_20260804_unit_mm (singleton, inserted_by_patch) VALUES (true, false);
    ELSE
      INSERT INTO public.units (code, label) VALUES ('mm', 'Millimètre');
      INSERT INTO public.cerp_patch_20260804_unit_mm (singleton, inserted_by_patch) VALUES (true, true);
    END IF;
  END IF;
END $$;

COMMIT;
