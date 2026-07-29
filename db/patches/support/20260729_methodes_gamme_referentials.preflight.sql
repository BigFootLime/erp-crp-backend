-- Preflight 20260729_methodes_gamme_referentials — LECTURE SEULE.
-- Confirme les pré-requis, l'absence des objets créés par le patch, et relève
-- la volumétrie AVANT pour la comparer au verify.

SELECT
  current_database()                                                        AS database,

  -- 1) Pré-requis.
  to_regclass('public.centres_frais') IS NOT NULL                           AS req_centres_frais,
  to_regclass('public.machines') IS NOT NULL                                AS req_machines,
  to_regclass('public.gammes') IS NOT NULL                                  AS req_gammes,
  to_regclass('public.pieces_techniques_operations') IS NOT NULL            AS req_operations,
  to_regclass('public.of_operations') IS NOT NULL                           AS req_of_operations,
  to_regclass('public.users') IS NOT NULL                                   AS req_users,
  (SELECT COUNT(*) FROM pg_proc WHERE proname = 'gen_random_uuid') > 0      AS req_gen_random_uuid,

  -- 2) Les tables du chantier ne doivent pas préexister.
  to_regclass('public.production_machine_families') IS NULL                 AS t_families_absent,
  to_regclass('public.production_cost_center_rates') IS NULL                AS t_rates_absent,

  -- 3) Les colonnes additives ne doivent pas préexister sous un autre sens.
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='centres_frais'
                AND column_name='machine_family_code')                      AS col_cf_family_absent,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='machines'
                AND column_name='machine_family_code')                      AS col_machine_family_absent,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='pieces_techniques_operations'
                AND column_name='numero_programme')                         AS col_op_programme_absent,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='pieces_techniques_operations'
                AND column_name='taux_horaire_legacy')                      AS col_op_taux_legacy_absent,
  NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='of_operations'
                AND column_name='numero_programme')                         AS col_of_programme_absent,

  -- 4) Les index uniques conditionnels sont-ils réalisables ?
  --    `false` n'est PAS bloquant : le patch les saute et le verify le signalera.
  NOT EXISTS (SELECT 1 FROM public.centres_frais
              GROUP BY upper(btrim(code)) HAVING COUNT(*) > 1)              AS cf_code_unique_possible,
  NOT EXISTS (SELECT 1 FROM public.pieces_techniques_operations
              WHERE gamme_id IS NOT NULL
              GROUP BY gamme_id, phase HAVING COUNT(*) > 1)                 AS gamme_phase_unique_possible,

  -- 5) Volumétrie AVANT (doit être identique au verify : aucune ligne créée
  --    ni supprimée par le patch).
  (SELECT COUNT(*) FROM public.centres_frais)                               AS centres_frais_rows_before,
  (SELECT COUNT(*) FROM public.machines)                                    AS machines_rows_before,
  (SELECT COUNT(*) FROM public.gammes)                                      AS gammes_rows_before,
  (SELECT COUNT(*) FROM public.pieces_techniques_operations)                AS operations_rows_before,
  (SELECT COUNT(*) FROM public.of_operations)                               AS of_operations_rows_before,

  -- 6) Périmètre exact de la recopie de conservation (section 6 du patch) :
  --    ces lignes recevront `taux_horaire_legacy` et `taux_horaire_source`.
  (SELECT COUNT(*) FROM public.pieces_techniques_operations
   WHERE taux_horaire IS NOT NULL AND taux_horaire <> 0)                    AS operations_avec_taux_a_conserver,

  -- 7) Le type d'opération DECOUPE ne doit encore exister nulle part.
  (SELECT COUNT(*) FROM public.pieces_techniques_operations
   WHERE type_operation = 'DECOUPE')                                        AS operations_decoupe_before;

-- 8) Détail des taux qui seront conservés : trace lisible avant/après.
SELECT id::text AS operation_id, gamme_id::text AS gamme_id, phase, designation,
       taux_horaire, temps_total, cout_mo
FROM public.pieces_techniques_operations
WHERE taux_horaire IS NOT NULL AND taux_horaire <> 0
ORDER BY gamme_id NULLS LAST, phase
LIMIT 200;
