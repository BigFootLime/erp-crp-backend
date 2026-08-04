-- #475 / BUG-CERP-0013 — Canonical article/stock unit contract.
--
-- public.units remains the authoritative referential. The application maps
-- historical piece aliases (PCE/PCS/PC, any case) to `u` and normalises other
-- codes to lower case without converting quantities. Existing article values
-- are intentionally left untouched and remain readable through that adapter.
--
-- The canonical codes observed in article, stock and production contracts are
-- seeded additively: u already comes from 20260223; this patch ensures mm, m
-- and kg. It is idempotent and records exactly which rows it introduced so the
-- companion rollback cannot delete pre-existing reference data.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.units') IS NULL THEN
    RAISE EXCEPTION '#475: public.units is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.units WHERE lower(code::text) = 'u') THEN
    RAISE EXCEPTION '#475: canonical base unit u must be seeded by 20260223 first';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.cerp_patch_20260804_stock_units (
  code text PRIMARY KEY,
  unit_id text NOT NULL,
  inserted_by_patch boolean NOT NULL
);

DO $$
DECLARE seed record;
        v_unit_id text;
BEGIN
  FOR seed IN
    SELECT * FROM (VALUES
      ('mm'::text, 'Millimètre'::text),
      ('m'::text,  'Mètre'::text),
      ('kg'::text, 'Kilogramme'::text)
    ) AS seeded(code, label)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.cerp_patch_20260804_stock_units WHERE code = seed.code) THEN
      SELECT id::text INTO v_unit_id
      FROM public.units
      WHERE lower(code::text) = seed.code
      LIMIT 1;

      IF v_unit_id IS NOT NULL THEN
        INSERT INTO public.cerp_patch_20260804_stock_units (code, unit_id, inserted_by_patch)
        VALUES (seed.code, v_unit_id, false);
      ELSE
        INSERT INTO public.units (code, label)
        VALUES (seed.code, seed.label)
        RETURNING id::text INTO v_unit_id;

        INSERT INTO public.cerp_patch_20260804_stock_units (code, unit_id, inserted_by_patch)
        VALUES (seed.code, v_unit_id, true);
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
