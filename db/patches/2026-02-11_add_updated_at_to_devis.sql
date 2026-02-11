-- Adds updated_at support for public.devis.
-- Required because the frontend sends sortBy=updated_at for /api/v1/devis.

ALTER TABLE public.devis
  ADD COLUMN IF NOT EXISTS updated_at timestamp without time zone;

UPDATE public.devis
SET updated_at = COALESCE(updated_at, date_creation, CURRENT_TIMESTAMP)
WHERE updated_at IS NULL;

ALTER TABLE public.devis
  ALTER COLUMN updated_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE public.devis
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS devis_updated_at_idx
  ON public.devis (updated_at);

DROP TRIGGER IF EXISTS devis_set_updated_at ON public.devis;
CREATE TRIGGER devis_set_updated_at
  BEFORE UPDATE ON public.devis
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_set_updated_at();
