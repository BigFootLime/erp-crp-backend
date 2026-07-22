-- 20260721_clients_compta_fields.rollback.sql
-- Rollback — À N'EXÉCUTER QUE SUR DÉCISION HUMAINE EXPLICITE.
-- Le patch étant strictement additif, ce rollback retire uniquement ce qu'il a ajouté.
-- PERTE DE DONNÉES ASSUMÉE : les valeurs compte_tiers/groupe_financier saisies sont
-- supprimées. Aucune donnée préexistante n'est touchée.
-- Après rollback, retirer aussi la ligne correspondante de public.cerp_schema_migrations
-- si l'on veut ré-appliquer le patch :
--   DELETE FROM public.cerp_schema_migrations WHERE filename = '20260721_clients_compta_fields.sql';

BEGIN;

ALTER TABLE public.clients DROP COLUMN IF EXISTS groupe_financier;
ALTER TABLE public.clients DROP COLUMN IF EXISTS compte_tiers;

COMMIT;
