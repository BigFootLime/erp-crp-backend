-- A 100% yield from the original default does not prove that Methods reviewed
-- it.  Preserve the recorded percentage, but record an explicit qualification
-- before it can be used for a MAKE assumption.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.industrial_article_rules
  ADD COLUMN IF NOT EXISTS yield_qualified_at timestamptz NULL;

-- A sub-100 historical rule cannot have come from the old default and is
-- therefore an explicit, usable parameter.  Existing 100% values remain
-- deliberately unqualified until an administrator edits that field.
UPDATE public.industrial_article_rules
   SET yield_qualified_at = COALESCE(yield_qualified_at, now())
 WHERE yield_percent < 100;

COMMIT;
