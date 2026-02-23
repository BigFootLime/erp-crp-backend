-- Bridge legacy magasin/emplacement to canonical warehouse/location.
-- Idempotent patch.

BEGIN;

ALTER TABLE public.magasins
  ADD COLUMN IF NOT EXISTS warehouse_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'magasins_warehouse_id_fkey'
      AND conrelid = 'public.magasins'::regclass
  ) THEN
    ALTER TABLE public.magasins
      ADD CONSTRAINT magasins_warehouse_id_fkey
      FOREIGN KEY (warehouse_id) REFERENCES public.warehouses(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS magasins_warehouse_id_idx ON public.magasins (warehouse_id);

ALTER TABLE public.emplacements
  ADD COLUMN IF NOT EXISTS location_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'emplacements_location_id_fkey'
      AND conrelid = 'public.emplacements'::regclass
  ) THEN
    ALTER TABLE public.emplacements
      ADD CONSTRAINT emplacements_location_id_fkey
      FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS emplacements_location_id_idx ON public.emplacements (location_id);

-- Enforce 1:1 mapping when set.
CREATE UNIQUE INDEX IF NOT EXISTS emplacements_location_id_uniq
  ON public.emplacements (location_id)
  WHERE location_id IS NOT NULL;

COMMIT;
