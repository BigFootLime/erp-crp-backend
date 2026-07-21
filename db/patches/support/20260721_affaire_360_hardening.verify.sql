-- Verify pour 20260721_affaire_360_hardening. À exécuter APRÈS l'application (cerp_test puis,
-- sur autorisation, cerp_prod). Confirme la présence des objets et l'accès du rôle applicatif.
\echo '== Colonnes ajoutées (attendu : is_principal bool NOT NULL def false ; archived_at timestamptz NULL) =='
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'affaire'
   AND column_name IN ('is_principal', 'archived_at')
 ORDER BY column_name;

\echo '== Index unique partiel (attendu : présent, WHERE is_principal AND commande_id IS NOT NULL) =='
SELECT indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'affaire'
   AND indexname = 'affaire_principal_par_commande_uniq';

\echo '== Le rôle applicatif cerp_app lit bien les nouvelles colonnes (pas de 42501) =='
SET ROLE cerp_app;
SELECT count(*) FILTER (WHERE is_principal) AS principals,
       count(*) FILTER (WHERE archived_at IS NOT NULL) AS archived
  FROM public.affaire;
RESET ROLE;

\echo '== Migration enregistrée =='
SELECT filename FROM public.cerp_schema_migrations WHERE filename = '20260721_affaire_360_hardening.sql';
