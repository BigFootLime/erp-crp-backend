-- Read-only preflight. Every boolean must be true before applying SOL-19.
SELECT
  current_setting('server_version_num')::integer >= 150000 AS postgres_15_or_newer,
  pg_has_role(current_user, 'cerp_migrator', 'MEMBER') AS migrator_role,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS runtime_role,
  to_regclass('public.stock_levels') IS NOT NULL AS stock_levels_present,
  to_regclass('public.stock_movements') IS NOT NULL AS movements_present,
  to_regclass('public.stock_reservations') IS NOT NULL AS reservations_present,
  to_regclass('public.stock_inventory_sessions') IS NOT NULL AS inventories_present,
  to_regclass('public.commande_fournisseur_ligne') IS NOT NULL AS supplier_order_lines_present,
  to_regclass('public.v_stock_availability_225') IS NOT NULL AS authoritative_availability_present,
  to_regclass('public.stock_intelligence_policy_versions') IS NULL AS policy_target_absent,
  to_regclass('public.stock_intelligence_command_receipts') IS NULL AS receipt_target_absent;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
       pg_size_pretty(pg_tablespace_size('pg_default')) AS tablespace_size;

-- Operator prerequisite: a verified pg_dump backup and checksum must exist
-- outside this database. This read-only preflight cannot manufacture that proof.
