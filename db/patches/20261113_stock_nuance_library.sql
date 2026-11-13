-- Additive library: preserve IDs, workshop codes, article links and density units.
-- No equivalence is inferred from historical codes. Conflicts abort atomically.
BEGIN;
LOCK TABLE public.stock_nuances IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.stock_nuance_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT regexp_replace(translate(upper(value), 'ÀÂÄÁÃÅÇÈÉÊËÌÍÎÏÑÒÓÔÖÕÙÚÛÜÝŸ', 'AAAAAACEEEEIIIINOOOOOUUUUYY'), '[^A-Z0-9]', '', 'g')
$$;

ALTER TABLE public.stock_nuances
  ADD COLUMN IF NOT EXISTS norme_fr text,
  ADD COLUMN IF NOT EXISTS norme_en text,
  ADD COLUMN IF NOT EXISTS norme_werkstoff text,
  ADD COLUMN IF NOT EXISTS norme_usa text,
  ADD COLUMN IF NOT EXISTS designation_principale text NOT NULL DEFAULT 'LEGACY';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.stock_nuances GROUP BY public.stock_nuance_key(code) HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM public.stock_nuances WHERE public.stock_nuance_key(code) = '') THEN
    RAISE EXCEPTION 'Nuance library: historical codes need review; no row was deleted or merged. Run the preflight report.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.stock_nuances'::regclass AND conname='stock_nuance_library_identity_check') THEN
    ALTER TABLE public.stock_nuances ADD CONSTRAINT stock_nuance_library_identity_check CHECK (
      (designation_principale = 'LEGACY' AND norme_fr IS NULL AND norme_en IS NULL AND norme_werkstoff IS NULL AND norme_usa IS NULL)
      OR (designation_principale = 'FR' AND nullif(btrim(norme_fr), '') IS NOT NULL)
      OR (designation_principale = 'EN' AND nullif(btrim(norme_en), '') IS NOT NULL)
      OR (designation_principale = 'WERKSTOFF' AND nullif(btrim(norme_werkstoff), '') IS NOT NULL)
      OR (designation_principale = 'USA' AND nullif(btrim(norme_usa), '') IS NOT NULL)
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_library_code_uniq ON public.stock_nuances (public.stock_nuance_key(code));
CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_library_fr_uniq ON public.stock_nuances (public.stock_nuance_key(norme_fr)) WHERE norme_fr IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_library_en_uniq ON public.stock_nuances (public.stock_nuance_key(norme_en)) WHERE norme_en IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_library_werkstoff_uniq ON public.stock_nuances (public.stock_nuance_key(norme_werkstoff)) WHERE norme_werkstoff IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_nuances_library_usa_uniq ON public.stock_nuances (public.stock_nuance_key(norme_usa)) WHERE norme_usa IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_stock_nuance_library() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize the legacy/standard cross-check, including concurrent inserts.
  -- The repository acquires this lock before its row lock as well.
  PERFORM pg_advisory_xact_lock(20261113, 84);
  NEW.norme_fr := nullif(btrim(NEW.norme_fr), '');
  NEW.norme_en := nullif(btrim(NEW.norme_en), '');
  NEW.norme_werkstoff := nullif(btrim(NEW.norme_werkstoff), '');
  NEW.norme_usa := nullif(btrim(NEW.norme_usa), '');
  IF TG_OP = 'INSERT' AND NEW.designation_principale = 'LEGACY' THEN
    RAISE EXCEPTION 'At least one standard designation is required' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.designation_principale <> 'LEGACY' AND NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'Classified nuance workshop code is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.designation_principale <> 'LEGACY' AND NEW.designation_principale = 'LEGACY' THEN
    RAISE EXCEPTION 'A classified nuance must retain a standard designation' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW.norme_fr, NEW.norme_en, NEW.norme_werkstoff, NEW.norme_usa]) value
    WHERE value IS NOT NULL AND (length(value) > 40 OR public.stock_nuance_key(value) = '')) THEN
    RAISE EXCEPTION 'Invalid standard designation' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stock_nuances existing WHERE existing.id <> NEW.id AND (
      (existing.designation_principale='LEGACY' AND public.stock_nuance_key(existing.code) = ANY (
        ARRAY[public.stock_nuance_key(NEW.norme_fr), public.stock_nuance_key(NEW.norme_en), public.stock_nuance_key(NEW.norme_werkstoff), public.stock_nuance_key(NEW.norme_usa)]))
      OR (NEW.designation_principale='LEGACY' AND public.stock_nuance_key(NEW.code) = ANY (
        ARRAY[public.stock_nuance_key(existing.norme_fr), public.stock_nuance_key(existing.norme_en), public.stock_nuance_key(existing.norme_werkstoff), public.stock_nuance_key(existing.norme_usa)]))
    )
  ) THEN
    RAISE EXCEPTION 'An existing historical nuance already uses this designation' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS stock_nuance_library_guard ON public.stock_nuances;
CREATE TRIGGER stock_nuance_library_guard BEFORE INSERT OR UPDATE ON public.stock_nuances
FOR EACH ROW EXECUTE FUNCTION public.guard_stock_nuance_library();
COMMIT;
