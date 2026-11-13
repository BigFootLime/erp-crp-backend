-- Read-only prerequisites. Execute against the intended company database.
SELECT current_database() AS database_name,
       to_regclass('public.users') IS NOT NULL AS users_present,
       to_regclass('public.units') IS NOT NULL AS units_present,
       to_regclass('public.clients') IS NOT NULL AS clients_present,
       to_regclass('public.fournisseurs') IS NOT NULL AS suppliers_present,
       to_regclass('public.articles') IS NOT NULL AS articles_present,
       to_regclass('public.pieces_techniques') IS NOT NULL AS technical_pieces_present;
SELECT table_name,column_name,data_type
FROM information_schema.columns
WHERE table_schema='public' AND (table_name,column_name) IN
  (('users','id'),('users','status'),('units','code'),('units','label'),
   ('clients','client_id'),('clients','client_code'),('fournisseurs','code_fournisseur'),
   ('articles','id'),('pieces_techniques','deleted_at'))
ORDER BY table_name,column_name;
-- This patch contains no INSERT/UPDATE into native business tables or counters.
