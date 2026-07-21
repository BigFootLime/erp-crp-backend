-- Preflight (LECTURE SEULE) pour 20260721_affaire_360_hardening.
-- Ne modifie rien. À exécuter sur cerp_test AVANT l'application pour confirmer l'état de départ.
\echo '== Colonnes affaire ciblées (avant apply : normalement absentes) =='
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'affaire'
   AND column_name IN ('is_principal', 'archived_at')
 ORDER BY column_name;

\echo '== Index principal déjà présent ? (avant apply : aucune ligne) =='
SELECT indexname
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'affaire'
   AND indexname = 'affaire_principal_par_commande_uniq';

\echo '== Contexte : nombre d''affaires + commandes portant >1 affaire (split-livraison) =='
SELECT count(*) AS affaire_rows FROM public.affaire;
SELECT count(*) AS commandes_multi_affaires
  FROM (
    SELECT commande_id FROM public.affaire
     WHERE commande_id IS NOT NULL
     GROUP BY commande_id HAVING count(*) > 1
  ) m;
