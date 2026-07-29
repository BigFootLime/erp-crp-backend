-- Preflight LECTURE SEULE de 20260729_methodes_machine_qualification_233.sql.
-- Aucune écriture. À exécuter avant le patch, sur cerp_test puis sur cerp_prod.

\echo '== 1. Cible et pré-requis =='
SELECT current_database()                                            AS database,
       to_regclass('public.production_machine_families') IS NOT NULL AS prereq_familles,
       to_regclass('public.machines')                    IS NOT NULL AS prereq_machines,
       to_regclass('public.production_machine_qualifications') IS NOT NULL AS deja_applique;

\echo '== 2. Parc machine — ce que le patch NE touche PAS =='
SELECT count(*)                                            AS machines_actives,
       count(*) FILTER (WHERE machine_family_code IS NULL) AS sans_famille,
       count(*) FILTER (WHERE cf_id IS NULL)               AS sans_centre_de_frais
  FROM public.machines
 WHERE archived_at IS NULL;

\echo '== 3. Doublons de phase bloquant l''index unique (gamme_id, phase) =='
SELECT gamme_id::text AS gamme_id, phase, count(*) AS operations
  FROM public.pieces_techniques_operations
 WHERE gamme_id IS NOT NULL
 GROUP BY gamme_id, phase
HAVING count(*) > 1
 ORDER BY gamme_id, phase;

\echo '== 4. Index unique deja present ? =='
SELECT EXISTS (
  SELECT 1 FROM pg_class WHERE relname = 'pt_operations_gamme_phase_uidx' AND relkind = 'i'
) AS idx_gamme_phase_unique;
