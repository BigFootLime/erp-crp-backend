-- Seed minimal reference data required by stock module.
-- Idempotent patch.

BEGIN;

-- stock_movements.currency defaults to EUR and has FK to currencies(code)
INSERT INTO public.currencies (code, name)
VALUES ('EUR', 'Euro')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- stock_levels.unit_id has FK to units(id)
INSERT INTO public.units (code, label)
VALUES ('u', 'Unite')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

COMMIT;
