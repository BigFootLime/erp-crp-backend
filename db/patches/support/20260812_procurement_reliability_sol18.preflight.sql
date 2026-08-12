-- Read-only preflight. Every boolean must be true before applying SOL-18.
SELECT
  current_setting('server_version_num')::integer >= 150000 AS postgres_15_or_newer,
  pg_has_role(current_user, 'cerp_migrator', 'MEMBER') AS migrator_role,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS runtime_role,
  to_regclass('public.commande_fournisseur') IS NOT NULL AS orders_present,
  to_regclass('public.commande_fournisseur_ligne') IS NOT NULL AS order_lines_present,
  to_regclass('public.receptions_fournisseurs') IS NOT NULL AS receipts_present,
  to_regclass('public.reception_fournisseur_lignes') IS NOT NULL AS receipt_lines_present,
  to_regclass('public.reception_incoming_inspections') IS NOT NULL AS incoming_quality_present,
  to_regclass('public.lots') IS NOT NULL AS lots_present,
  to_regclass('public.procurement_promised_date_events') IS NULL AS promises_target_absent,
  to_regclass('public.procurement_anomaly_actions') IS NULL AS anomaly_target_absent,
  to_regclass('public.procurement_policy_versions') IS NULL AS policy_target_absent,
  to_regclass('public.procurement_command_receipts') IS NULL AS receipts_target_absent;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size,
       pg_size_pretty(pg_tablespace_size('pg_default')) AS tablespace_size;

-- Operator prerequisite: a verified pg_dump backup and checksum must exist outside
-- this database before execution. This query deliberately cannot fake that proof.
