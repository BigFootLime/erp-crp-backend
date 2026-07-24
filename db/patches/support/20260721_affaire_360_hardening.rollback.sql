-- Rollback pour 20260721_affaire_360_hardening.
-- À n'exécuter QUE pour annuler le patch (retire les objets additifs). Ne supprime aucune
-- donnée métier autre que les deux colonnes introduites par ce patch.
BEGIN;

DROP INDEX IF EXISTS public.affaire_principal_par_commande_uniq;

ALTER TABLE public.affaire DROP COLUMN IF EXISTS archived_at;
ALTER TABLE public.affaire DROP COLUMN IF EXISTS is_principal;

DELETE FROM public.cerp_schema_migrations WHERE filename = '20260721_affaire_360_hardening.sql';

COMMIT;
