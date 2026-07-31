-- #433 — Révision d'une gamme APPLICABLE : filiation et idempotence.
--
-- Une gamme applicable est immuable : les OF lancés et l'historique s'appuient
-- dessus. Pour ajouter une opération, on prépare une RÉVISION — un nouveau
-- brouillon dupliqué depuis la gamme figée. Deux informations manquaient pour
-- que cette opération soit sûre :
--
--   · `source_gamme_id` — de quelle gamme la révision est issue, pour l'audit
--     et pour l'écran (« révision de la gamme X ») ;
--   · `revision_idempotency_key` — un double clic, un rejeu après coupure ou un
--     retour arrière du navigateur doivent rendre LA MÊME révision, pas une
--     deuxième gamme en double.
--
-- Migration ADDITIVE et idempotente : aucune colonne existante n'est touchée,
-- aucune donnée n'est réécrite. Les gammes historiques gardent
-- `source_gamme_id = NULL`, ce qui signifie simplement « créée directement ».
--
-- NON EXÉCUTÉE : à appliquer sur cerp_test d'abord, jamais automatiquement sur
-- cerp_prod (preflight / verify / rollback dans db/patches/support).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.gammes') IS NULL THEN
    RAISE EXCEPTION 'Pré-requis absent: public.gammes';
  END IF;
END $$;

ALTER TABLE public.gammes
  ADD COLUMN IF NOT EXISTS source_gamme_id uuid NULL,
  ADD COLUMN IF NOT EXISTS revision_idempotency_key text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gammes_source_gamme_id_fkey'
      AND conrelid = 'public.gammes'::regclass
  ) THEN
    ALTER TABLE public.gammes
      ADD CONSTRAINT gammes_source_gamme_id_fkey
      FOREIGN KEY (source_gamme_id) REFERENCES public.gammes (id) ON DELETE SET NULL;
  END IF;
END $$;

-- Une clé d'idempotence ne vaut que pour la gamme source : deux gammes
-- différentes peuvent recevoir la même clé sans conflit, une même gamme ne peut
-- produire qu'une révision par clé.
CREATE UNIQUE INDEX IF NOT EXISTS gammes_revision_idempotency_uidx
  ON public.gammes (source_gamme_id, revision_idempotency_key)
  WHERE revision_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS gammes_source_gamme_id_idx
  ON public.gammes (source_gamme_id)
  WHERE source_gamme_id IS NOT NULL;

COMMENT ON COLUMN public.gammes.source_gamme_id IS
  '#433 — gamme dont celle-ci est la révision. NULL = gamme créée directement.';
COMMENT ON COLUMN public.gammes.revision_idempotency_key IS
  '#433 — clé d''idempotence du rejeu de « Préparer une révision ». Unique par gamme source.';

COMMIT;
