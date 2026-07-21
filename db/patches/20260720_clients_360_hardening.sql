-- 20260720_clients_360_hardening.sql
-- #162 (BigFootLime/crp-systems-web#162) — Client 360 : évolutions ADDITIVES du référentiel clients.
--
-- STRICTEMENT ADDITIF : aucune colonne existante modifiée/supprimée, aucune ligne
-- détruite, idempotent (IF NOT EXISTS partout). L'application actuelle fonctionne
-- inchangée sans ce patch ; le code #162 « extension 360 » le requiert.
-- Ordre de release : appliquer ce patch (cerp_test d'abord) AVANT de déployer le code.
-- Verify   : db/patches/support/20260720_clients_360_hardening.verify.sql
-- Rollback : db/patches/support/20260720_clients_360_hardening.rollback.sql
--
-- Contenu :
--   1. clients.client_uuid       — identité technique cible (UUID stable) pour les
--                                  futures relations, en coexistence avec la PK
--                                  legacy client_id (varchar "001"). Aucune FK ne
--                                  bascule ici (évolution documentée, pas de
--                                  pseudo-migration).
--   2. Archivage logique horodaté (archived_at/archived_by) en complément de la
--      convention status='inactif'.
--   3. Colonnes d'audit created_at/updated_at/created_by/updated_by (pattern
--      fournisseurs), backfill created_at depuis creation_date.
--   4. Finance/logistique structurés : devise, encours_max, incoterm, langue
--      (fin de la concaténation de données métier dans observations).
--   5. contacts.archived_at — désactivation logique des contacts (jamais de
--      DELETE physique par les flux applicatifs).
--   6. client_create_idempotency — rejeu sûr du POST /clients (double soumission).
--   7. Index de recherche SIRET (non unique : des doublons legacy peuvent exister ;
--      l'index UNIQUE est la cible une fois le verify sans doublons — voir script).

BEGIN;

-- 1) Identité technique cible ------------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS client_uuid uuid NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS clients_client_uuid_uniq
  ON public.clients (client_uuid);

-- 2) Archivage logique horodaté ----------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS archived_by integer NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_archived_by_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_archived_by_fkey
      FOREIGN KEY (archived_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3) Audit création/modification (pattern fournisseurs) -----------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS created_by integer NULL;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS updated_by integer NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_created_by_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_updated_by_fkey'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_updated_by_fkey
      FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill : les fiches legacy gardent leur date métier comme date de création
-- technique (sinon DEFAULT now() mentirait sur l'ancienneté).
UPDATE public.clients
   SET created_at = creation_date
 WHERE creation_date IS NOT NULL
   AND created_at > creation_date;

-- Trigger updated_at : réutilise public.tg_set_updated_at() si présent (même
-- garde que le patch fournisseurs — on n'échoue pas si la fonction manque).
DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping clients updated_at trigger.';
  ELSE
    EXECUTE 'DROP TRIGGER IF EXISTS clients_set_updated_at ON public.clients';
    EXECUTE 'CREATE TRIGGER clients_set_updated_at
             BEFORE UPDATE ON public.clients
             FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

-- 4) Finance / logistique structurés ------------------------------------------
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS devise text NULL;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS encours_max numeric(12,2) NULL;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS incoterm text NULL;
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS langue text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_encours_max_non_negative'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_encours_max_non_negative
      CHECK (encours_max IS NULL OR encours_max >= 0);
  END IF;
END $$;

-- 5) Désactivation logique des contacts ---------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS archived_at timestamptz NULL;

-- 6) Idempotence de création ---------------------------------------------------
-- Pas de FK vers clients(client_id) : table de bookkeeping éphémère (rejeu de
-- POST), la PK legacy varchar(3) est amenée à évoluer vers client_uuid.
CREATE TABLE IF NOT EXISTS public.client_create_idempotency (
  idempotency_key uuid PRIMARY KEY,
  client_id       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 7) Index de recherche SIRET --------------------------------------------------
CREATE INDEX IF NOT EXISTS clients_siret_idx
  ON public.clients (siret)
  WHERE siret IS NOT NULL;

COMMIT;
