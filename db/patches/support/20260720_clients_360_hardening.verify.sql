-- 20260720_clients_360_hardening.verify.sql
-- Vérification post-application du patch #162 (lecture seule, aucun effet de bord).
-- Usage : psql "$DATABASE_URL" -f db/patches/support/20260720_clients_360_hardening.verify.sql
-- Attendu : chaque bloc renvoie ok=true (ou un décompte explicite commenté).

-- 1) Colonnes ajoutées sur clients
SELECT
  COUNT(*) FILTER (WHERE column_name = 'client_uuid')  = 1 AS has_client_uuid,
  COUNT(*) FILTER (WHERE column_name = 'archived_at')  = 1 AS has_archived_at,
  COUNT(*) FILTER (WHERE column_name = 'archived_by')  = 1 AS has_archived_by,
  COUNT(*) FILTER (WHERE column_name = 'created_at')   = 1 AS has_created_at,
  COUNT(*) FILTER (WHERE column_name = 'updated_at')   = 1 AS has_updated_at,
  COUNT(*) FILTER (WHERE column_name = 'created_by')   = 1 AS has_created_by,
  COUNT(*) FILTER (WHERE column_name = 'updated_by')   = 1 AS has_updated_by,
  COUNT(*) FILTER (WHERE column_name = 'devise')       = 1 AS has_devise,
  COUNT(*) FILTER (WHERE column_name = 'encours_max')  = 1 AS has_encours_max,
  COUNT(*) FILTER (WHERE column_name = 'incoterm')     = 1 AS has_incoterm,
  COUNT(*) FILTER (WHERE column_name = 'langue')       = 1 AS has_langue
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'clients';

-- 2) Colonne contacts.archived_at
SELECT COUNT(*) = 1 AS has_contacts_archived_at
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'archived_at';

-- 3) Table d'idempotence
SELECT to_regclass('public.client_create_idempotency') IS NOT NULL AS has_idempotency_table;

-- 4) Index
SELECT
  COUNT(*) FILTER (WHERE indexname = 'clients_client_uuid_uniq') = 1 AS has_uuid_unique_index,
  COUNT(*) FILTER (WHERE indexname = 'clients_siret_idx')        = 1 AS has_siret_index
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'clients';

-- 5) Unicité effective des UUID (attendu : 0 doublon)
SELECT COUNT(*) AS duplicated_client_uuids
FROM (
  SELECT client_uuid FROM public.clients GROUP BY client_uuid HAVING COUNT(*) > 1
) d;

-- 6) Backfill created_at : aucune fiche legacy avec created_at postérieur à
--    creation_date (attendu : 0)
SELECT COUNT(*) AS created_at_after_creation_date
FROM public.clients
WHERE creation_date IS NOT NULL AND created_at > creation_date;

-- 7) DOUBLONS SIRET LEGACY — décision différée documentée (#162) :
--    tant que ce décompte est > 0, l'index UNIQUE sur siret ne peut pas être
--    créé ; la garde applicative (409 CLIENT_SIRET_EXISTS) couvre les nouveaux
--    flux. Attendu à terme : 0, puis créer :
--    CREATE UNIQUE INDEX clients_siret_uniq ON public.clients (siret) WHERE siret IS NOT NULL;
SELECT COALESCE(SUM(cnt - 1), 0) AS legacy_duplicate_siret_rows
FROM (
  SELECT siret, COUNT(*) AS cnt
  FROM public.clients
  WHERE siret IS NOT NULL AND btrim(siret) <> ''
  GROUP BY siret
  HAVING COUNT(*) > 1
) d;

-- 8) Contrainte encours
SELECT COUNT(*) = 1 AS has_encours_check
FROM pg_constraint
WHERE conname = 'clients_encours_max_non_negative';
