-- SOL-06 drift repair: restore the canonical base unit when the historical
-- 20260223 seed is present in the ledger but its reference row is absent.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.units') IS NULL THEN
    RAISE EXCEPTION 'SOL-06 unit repair: public.units is missing';
  END IF;
  IF (SELECT count(*) FROM public.units WHERE lower(code::text) = 'u') > 1 THEN
    RAISE EXCEPTION 'SOL-06 unit repair: duplicate case-insensitive u codes must be reconciled';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.cerp_patch_20260811_base_unit_repair (
  code TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  inserted_by_patch BOOLEAN NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $repair$
DECLARE
  v_unit_id TEXT;
  v_inserted BOOLEAN := false;
BEGIN
  SELECT id::text INTO v_unit_id
  FROM public.units
  WHERE lower(code::text) = 'u'
  LIMIT 1;

  IF v_unit_id IS NULL THEN
    INSERT INTO public.units (code, label)
    VALUES ('u', 'Unite')
    RETURNING id::text INTO v_unit_id;
    v_inserted := true;
  END IF;

  INSERT INTO public.cerp_patch_20260811_base_unit_repair (
    code,
    unit_id,
    inserted_by_patch
  )
  VALUES ('u', v_unit_id, v_inserted)
  ON CONFLICT (code) DO UPDATE SET
    unit_id = EXCLUDED.unit_id,
    inserted_by_patch = public.cerp_patch_20260811_base_unit_repair.inserted_by_patch
      OR EXCLUDED.inserted_by_patch;
END
$repair$;

COMMIT;
