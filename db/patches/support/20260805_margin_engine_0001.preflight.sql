-- Lecture seule. A executer avant le patch dans la base cible.
SELECT current_database() AS database_name, current_user AS database_user;

SELECT
  to_regclass('public.users') AS users_table,
  to_regclass('public.devis') AS devis_table,
  to_regclass('public.devis_ligne') AS devis_line_table,
  to_regclass('public.ordres_fabrication') AS of_table,
  to_regclass('public.of_operations') AS of_operations_table;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('margin_rate_versions','margin_rates','margin_input_versions','margin_recalculations')
ORDER BY table_name;
