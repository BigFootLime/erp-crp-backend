\set ON_ERROR_STOP on

SELECT
  to_regclass('public.data_import_batches') AS existing_batches_table,
  to_regclass('public.data_import_rows') AS existing_rows_table,
  to_regclass('public.data_import_crosswalk') AS existing_crosswalk_table,
  (SELECT count(*) FROM public.users) AS users_available;

SELECT
  to_regclass('public.clients') AS clients_table,
  to_regclass('public.fournisseurs') AS fournisseurs_table,
  to_regclass('public.articles') AS articles_table,
  to_regclass('public.pieces_techniques') AS pieces_table,
  to_regclass('public.machines') AS machines_table;
