-- Rollback de 20260729_methodes_machine_qualification_233.sql.
--
-- ATTENTION : `DROP TABLE production_machine_qualifications` DÉTRUIT l'historique
-- des décisions de qualification. Ce n'est pas une opération d'hygiène — c'est la
-- perte d'une preuve d'audit. À n'exécuter que sur décision humaine explicite, et
-- après export du contenu (requête fournie ci-dessous).
--
-- Le rollback ne dé-qualifie AUCUNE machine : `machines.machine_family_code` et
-- `machines.cf_id` appartiennent au patch précédent et restent en place. Les
-- affectations déjà décidées survivent donc au retrait du journal.

-- 1) Export préalable — à exécuter et à conserver AVANT le DROP.
-- \copy (SELECT * FROM public.production_machine_qualifications ORDER BY created_at)
--   TO '/tmp/machine_qualifications_export.csv' WITH CSV HEADER

BEGIN;

DROP INDEX IF EXISTS public.machine_qualifications_machine_idx;
DROP TABLE IF EXISTS public.production_machine_qualifications;

-- L'index unique (gamme_id, phase) n'est PAS retiré : il protège les données de
-- gamme et n'est pas propre à ce patch (il était déjà tenté par
-- 20260729_methodes_gamme_referentials.sql). Pour le retirer explicitement :
--   DROP INDEX IF EXISTS public.pt_operations_gamme_phase_uidx;

COMMIT;
