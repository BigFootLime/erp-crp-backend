-- Verify LECTURE SEULE de 20260729_methodes_machine_qualification_233.sql.
-- Toutes les colonnes booléennes doivent valoir `t`, SAUF `idx_gamme_phase_unique`
-- qui reste `f` tant qu'une gamme porte deux opérations à la même phase.

\echo '== Contrôles structurels =='
SELECT
  current_database() AS database,
  to_regclass('public.production_machine_qualifications') IS NOT NULL AS table_journal,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conname = 'machine_qualifications_machine_fkey')     AS fk_machine,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conname = 'machine_qualifications_motif_ck')         AS ck_motif_obligatoire,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conname = 'machine_qualifications_change_ck')        AS ck_changement_reel,
  EXISTS (SELECT 1 FROM pg_constraint
           WHERE conname = 'machine_qualifications_validity_ck')      AS ck_validite,
  EXISTS (SELECT 1 FROM pg_class
           WHERE relname = 'machine_qualifications_machine_idx')      AS idx_journal,
  EXISTS (SELECT 1 FROM pg_class
           WHERE relname = 'pt_operations_gamme_phase_uidx' AND relkind = 'i') AS idx_gamme_phase_unique,
  -- Le patch ne qualifie AUCUNE machine : ces deux compteurs doivent être
  -- identiques avant et après application.
  (SELECT count(*) FROM public.machines WHERE archived_at IS NULL)    AS machines_actives,
  (SELECT count(*) FROM public.machines
    WHERE archived_at IS NULL AND machine_family_code IS NOT NULL)    AS machines_qualifiees,
  (SELECT count(*) FROM public.production_machine_qualifications)     AS decisions_journalisees,
  (SELECT relowner::regrole::text FROM pg_class
    WHERE relname = 'production_machine_qualifications')              AS owner_journal;

\echo '== Doublons de phase restants (doit etre vide pour que l''index existe) =='
SELECT gamme_id::text AS gamme_id, phase, count(*) AS operations
  FROM public.pieces_techniques_operations
 WHERE gamme_id IS NOT NULL
 GROUP BY gamme_id, phase
HAVING count(*) > 1
 ORDER BY gamme_id, phase;

\echo '== Parc machine : etat de qualification =='
SELECT m.code,
       COALESCE(m.machine_family_code, 'A QUALIFIER') AS famille,
       COALESCE(cf.code, '-')                        AS centre_de_frais,
       m.status::text                                AS statut
  FROM public.machines m
  LEFT JOIN public.centres_frais cf ON cf.id = m.cf_id
 WHERE m.archived_at IS NULL
 ORDER BY m.code;
