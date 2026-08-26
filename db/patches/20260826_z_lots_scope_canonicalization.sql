-- Canonicalize the temporary OLD/NEW column split introduced by parallel
-- additive changes.  `source_scope` is the canonical business field used by
-- reservation, receipt and delivery; `stock_scope` remains a synchronized
-- compatibility mirror until older stock readers have been migrated.
--
-- Apply after the same-day PT/article enrichment patch (the `z` prefix keeps
-- normal lexicographic patch runners in that order).  Safe if either column
-- already exists; no historical lot is deleted or silently reclassified.

BEGIN;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS source_scope TEXT NULL,
  ADD COLUMN IF NOT EXISTS stock_scope TEXT NULL;

-- Preserve a pre-existing OLD flag from the former stock field when the new
-- field was only default-filled to NEW during a rolling deployment.  Once both
-- values exist, source_scope wins and is mirrored back below.
UPDATE public.lots
SET source_scope = stock_scope
WHERE stock_scope IN ('OLD', 'NEW')
  AND (source_scope IS NULL OR (source_scope = 'NEW' AND stock_scope = 'OLD'));

UPDATE public.lots
SET source_scope = 'NEW'
WHERE source_scope IS NULL;

UPDATE public.lots
SET stock_scope = source_scope
WHERE stock_scope IS DISTINCT FROM source_scope;

ALTER TABLE public.lots
  ALTER COLUMN source_scope SET DEFAULT 'NEW';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_source_scope_chk'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_source_scope_chk
      CHECK (source_scope IS NULL OR source_scope IN ('OLD', 'NEW'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_stock_scope_check'
      AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_stock_scope_check
      CHECK (stock_scope IS NULL OR stock_scope IN ('OLD', 'NEW'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.tg_lots_sync_scope_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.source_scope := COALESCE(NEW.source_scope, NEW.stock_scope, 'NEW');
    -- Older writers only set stock_scope; source_scope is then its NEW default.
    -- Preserve their explicit OLD provenance instead of letting that default
    -- overwrite it during the transition.
    IF NEW.source_scope = 'NEW' AND NEW.stock_scope = 'OLD' THEN
      NEW.source_scope := 'OLD';
    END IF;
    NEW.stock_scope := NEW.source_scope;
  ELSIF NEW.source_scope IS DISTINCT FROM OLD.source_scope THEN
    NEW.stock_scope := NEW.source_scope;
  ELSIF NEW.stock_scope IS DISTINCT FROM OLD.stock_scope THEN
    NEW.source_scope := NEW.stock_scope;
  ELSE
    NEW.source_scope := COALESCE(NEW.source_scope, NEW.stock_scope, 'NEW');
    NEW.stock_scope := NEW.source_scope;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_sync_scope_columns ON public.lots;
CREATE TRIGGER lots_sync_scope_columns
BEFORE INSERT OR UPDATE OF source_scope, stock_scope ON public.lots
FOR EACH ROW EXECUTE FUNCTION public.tg_lots_sync_scope_columns();

CREATE INDEX IF NOT EXISTS lots_source_scope_fifo_idx
  ON public.lots (article_id, source_scope, received_at NULLS LAST, created_at, id);

COMMENT ON COLUMN public.lots.source_scope IS
  'Canonical OLD/NEW provenance used by reservation and delivery FIFO; stock_scope is a temporary synchronized compatibility mirror.';

COMMIT;
