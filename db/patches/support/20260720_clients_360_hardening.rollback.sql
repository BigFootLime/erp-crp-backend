-- 20260720_clients_360_hardening.rollback.sql
-- Rollback du patch #162 — À N'EXÉCUTER QUE SUR DÉCISION HUMAINE EXPLICITE.
-- Le patch étant strictement additif, ce rollback retire uniquement ce qu'il a
-- ajouté. PERTE DE DONNÉES ASSUMÉE : les valeurs saisies dans les nouvelles
-- colonnes (devise, encours_max, incoterm, langue, archived_*) et les clés
-- d'idempotence sont supprimées. Aucune donnée préexistante n'est touchée.
-- Après rollback, retirer aussi la ligne correspondante de
-- public.cerp_schema_migrations si l'on veut ré-appliquer le patch :
--   DELETE FROM public.cerp_schema_migrations WHERE filename = '20260720_clients_360_hardening.sql';

BEGIN;

DROP TRIGGER IF EXISTS clients_set_updated_at ON public.clients;

DROP INDEX IF EXISTS public.clients_siret_idx;
DROP INDEX IF EXISTS public.clients_client_uuid_uniq;

DROP TABLE IF EXISTS public.client_create_idempotency;

ALTER TABLE public.contacts DROP COLUMN IF EXISTS archived_at;

ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_encours_max_non_negative;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_archived_by_fkey;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_created_by_fkey;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_updated_by_fkey;

ALTER TABLE public.clients DROP COLUMN IF EXISTS langue;
ALTER TABLE public.clients DROP COLUMN IF EXISTS incoterm;
ALTER TABLE public.clients DROP COLUMN IF EXISTS encours_max;
ALTER TABLE public.clients DROP COLUMN IF EXISTS devise;
ALTER TABLE public.clients DROP COLUMN IF EXISTS updated_by;
ALTER TABLE public.clients DROP COLUMN IF EXISTS created_by;
ALTER TABLE public.clients DROP COLUMN IF EXISTS updated_at;
ALTER TABLE public.clients DROP COLUMN IF EXISTS created_at;
ALTER TABLE public.clients DROP COLUMN IF EXISTS archived_by;
ALTER TABLE public.clients DROP COLUMN IF EXISTS archived_at;
ALTER TABLE public.clients DROP COLUMN IF EXISTS client_uuid;

COMMIT;
