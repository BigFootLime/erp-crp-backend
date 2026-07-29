-- Verify 20260729_methodes_gamme_referentials — LECTURE SEULE.
-- Toutes les colonnes booléennes doivent être `true`, SAUF les deux index
-- conditionnels si le preflight avait relevé des doublons (voir §4).
-- Les comptes de lignes doivent être IDENTIQUES au preflight.

SELECT
  current_database()                                                        AS database,

  -- 1) Tables créées.
  to_regclass('public.production_machine_families') IS NOT NULL             AS t_families,
  to_regclass('public.production_cost_center_rates') IS NOT NULL            AS t_rates,

  -- 2) Référentiel de familles amorcé (5 familles initiales, extensible).
  (SELECT COUNT(*) FROM public.production_machine_families)                 AS familles_total,
  (SELECT COUNT(*) FROM public.production_machine_families
   WHERE code IN ('T','F','TTRAD','FTRAD','DECOUPE'))  = 5                  AS familles_initiales_presentes,
  (SELECT COUNT(*) FROM public.production_machine_families
   WHERE programme_requis) >= 2                                             AS familles_programme_requis,

  -- 3) Colonnes additives réellement posées.
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='centres_frais'
            AND column_name='machine_family_code')                          AS col_cf_family,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='centres_frais'
            AND column_name='statut')                                       AS col_cf_statut,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='centres_frais'
            AND column_name='designation_modele')                           AS col_cf_designation_modele,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='machines'
            AND column_name='machine_family_code')                          AS col_machine_family,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='machines'
            AND column_name='cf_id')                                        AS col_machine_cf,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='machines'
            AND column_name='valid_from')                                   AS col_machine_valid_from,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pieces_techniques_operations'
            AND column_name='numero_programme')                             AS col_op_programme,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pieces_techniques_operations'
            AND column_name='temps_fabrication')                            AS col_op_temps_fabrication,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pieces_techniques_operations'
            AND column_name='cf_rate_id')                                   AS col_op_cf_rate,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='pieces_techniques_operations'
            AND column_name='taux_horaire_legacy')                          AS col_op_taux_legacy,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='of_operations'
            AND column_name='numero_programme')                             AS col_of_programme,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='of_operations'
            AND column_name='temps_fabrication_planned')                    AS col_of_temps_fabrication,

  -- 4) Index et contraintes. Les deux `*_uidx` conditionnels valent `false`
  --    si et seulement si le preflight avait relevé des doublons.
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='cost_center_rates_cf_date_uidx')
                                                                            AS idx_rate_unique_per_date,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='cost_center_rates_cf_open_uidx')
                                                                            AS idx_rate_single_open,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='centres_frais_code_uidx')
                                                                            AS idx_cf_code_unique,
  EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='pt_operations_gamme_phase_uidx')
                                                                            AS idx_gamme_phase_unique,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='machines_family_fkey'
            AND conrelid='public.machines'::regclass)                       AS fk_machine_family,
  EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname='cost_center_rates_source_ck'
            AND conrelid='public.production_cost_center_rates'::regclass)    AS ck_rate_source_required,

  -- 5) `DECOUPE` accepté par le CHECK, sans perte des types existants.
  (SELECT pg_get_constraintdef(oid) LIKE '%DECOUPE%'
   FROM pg_constraint
   WHERE conname='pieces_techniques_operations_type_operation_check'
     AND conrelid='public.pieces_techniques_operations'::regclass)          AS ck_type_operation_decoupe,
  (SELECT pg_get_constraintdef(oid) LIKE '%SOUS_TRAITANCE%'
   FROM pg_constraint
   WHERE conname='pieces_techniques_operations_type_operation_check'
     AND conrelid='public.pieces_techniques_operations'::regclass)          AS ck_type_operation_preserve,

  -- 6) Volumétrie APRÈS : à comparer au preflight, doit être identique.
  (SELECT COUNT(*) FROM public.centres_frais)                               AS centres_frais_rows_after,
  (SELECT COUNT(*) FROM public.machines)                                    AS machines_rows_after,
  (SELECT COUNT(*) FROM public.gammes)                                      AS gammes_rows_after,
  (SELECT COUNT(*) FROM public.pieces_techniques_operations)                AS operations_rows_after,
  (SELECT COUNT(*) FROM public.of_operations)                               AS of_operations_rows_after,

  -- 7) Conservation : tout taux non nul a été recopié et étiqueté.
  (SELECT COUNT(*) FROM public.pieces_techniques_operations
   WHERE taux_horaire IS NOT NULL AND taux_horaire <> 0
     AND taux_horaire_legacy IS DISTINCT FROM taux_horaire)                 AS taux_non_conserves_doit_etre_0,
  (SELECT COUNT(*) FROM public.pieces_techniques_operations
   WHERE taux_horaire IS NOT NULL AND taux_horaire <> 0
     AND taux_horaire_source IS NULL)                                       AS taux_sans_source_doit_etre_0,

  -- 8) Aucune famille n'a été devinée : le backfill est volontairement absent.
  (SELECT COUNT(*) FROM public.machines WHERE machine_family_code IS NOT NULL)
                                                                            AS machines_famille_renseignee_attendu_0,

  -- 9) Propriétaire applicatif (piège 42501 si appliqué en `postgres`).
  (SELECT pg_get_userbyid(relowner)::text FROM pg_class
   WHERE relname='production_machine_families')                             AS owner_families,
  (SELECT pg_get_userbyid(relowner)::text FROM pg_class
   WHERE relname='production_cost_center_rates')                            AS owner_rates;

-- 10) Le référentiel tel qu'il est réellement en base.
SELECT code, libelle, programme_requis, est_favori, ordre_affichage, actif
FROM public.production_machine_families
ORDER BY ordre_affichage, code;

-- 11) Catalogue d'accès (#326) : il est optionnel, comme dans le patch.
-- Le SQL dynamique évite toute référence parse-time à la table si #326 n'est
-- pas encore appliqué dans l'environnement vérifié.
DO $$
DECLARE
  v_prefix boolean;
  v_nav boolean;
BEGIN
  IF to_regclass('public.access_modules') IS NULL THEN
    RAISE NOTICE 'access_modules absent: contrôle #326 non applicable';
  ELSE
    EXECUTE $query$
      SELECT '/methodes' = ANY(api_prefixes),
             'methodes-centres-frais' = ANY(nav_page_keys)
      FROM public.access_modules
      WHERE module_key = 'pieces-techniques'
    $query$ INTO v_prefix, v_nav;
    RAISE NOTICE 'catalogue #326: /methodes=%, centres-frais=%', v_prefix, v_nav;
  END IF;
END $$;
