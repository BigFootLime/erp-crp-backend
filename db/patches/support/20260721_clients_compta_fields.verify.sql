-- 20260721_clients_compta_fields.verify.sql
-- Vérification post-application (lecture seule, aucun effet de bord).
-- Usage : psql "$DATABASE_URL" -f db/patches/support/20260721_clients_compta_fields.verify.sql
-- Attendu : chaque colonne présente (ok=true).

SELECT
  COUNT(*) FILTER (WHERE column_name = 'compte_tiers')     = 1 AS has_compte_tiers,
  COUNT(*) FILTER (WHERE column_name = 'groupe_financier') = 1 AS has_groupe_financier
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'clients';
