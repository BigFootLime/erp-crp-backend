-- Rollback #433 — révision de gamme.
--
-- ⚠️ Ce rollback SUPPRIME la filiation et les clés d'idempotence enregistrées
-- depuis l'application du patch. Les gammes elles-mêmes, leurs opérations, les
-- OF et les snapshots ne sont pas touchés : seules deux colonnes additives
-- disparaissent.
--
-- Vérifier AVANT d'exécuter :
--   SELECT count(*) FROM public.gammes WHERE source_gamme_id IS NOT NULL;
-- Si le compte est > 0, la traçabilité « révision de » sera perdue. Exiger une
-- décision humaine explicite dans ce cas.

BEGIN;

DROP INDEX IF EXISTS public.gammes_revision_idempotency_uidx;
DROP INDEX IF EXISTS public.gammes_source_gamme_id_idx;

ALTER TABLE public.gammes
  DROP CONSTRAINT IF EXISTS gammes_source_gamme_id_fkey;

ALTER TABLE public.gammes
  DROP COLUMN IF EXISTS revision_idempotency_key,
  DROP COLUMN IF EXISTS source_gamme_id;

COMMIT;
