\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $preflight$
DECLARE
  expected_sha256 constant text := '9da8fc1d7a71a5cf1133995de85d2c2680eeec5f7d7ffbcaa826351d8f35e97e';
  registered_sha256 text;
  target_tables integer;
  target_triggers integer;
BEGIN
  IF to_regclass('public.cerp_schema_migrations') IS NULL
     OR to_regclass('public.devis') IS NULL
     OR to_regclass('public.devis_ligne') IS NULL
     OR to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_historique') IS NULL
     OR to_regclass('public.commande_client_event_log') IS NULL
     OR to_regclass('public.users') IS NULL
     OR to_regclass('public.erp_audit_logs') IS NULL
     OR to_regrole('cerp_app') IS NULL THEN
    RAISE EXCEPTION 'SOL-17 preflight: prerequisite table or runtime role is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.devis
    WHERE statut NOT IN ('BROUILLON','ENVOYE','ACCEPTE','REFUSE','EXPIRE','ANNULE')
  ) THEN
    RAISE EXCEPTION 'SOL-17 preflight: devis contains an unknown status';
  END IF;

  SELECT sha256 INTO registered_sha256
  FROM public.cerp_schema_migrations
  WHERE filename='20260812_commercial_reliability_sol17.sql';

  SELECT COUNT(*)::integer INTO target_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(ARRAY[
    'commercial_quote_events','commercial_order_cancellations','commercial_command_receipts'
  ]);
  SELECT COUNT(*)::integer INTO target_triggers
  FROM pg_trigger WHERE NOT tgisinternal AND tgname=ANY(ARRAY[
    'commercial_quote_events_append_only','commercial_order_cancellations_append_only',
    'commercial_command_receipts_append_only'
  ]);

  IF registered_sha256 IS NULL THEN
    IF target_tables<>0 OR target_triggers<>0 OR to_regprocedure('public.fn_commercial_evidence_append_only()') IS NOT NULL THEN
      RAISE EXCEPTION 'SOL-17 preflight: target artifact exists without ledger provenance';
    END IF;
    RETURN;
  END IF;
  IF registered_sha256<>expected_sha256 THEN
    RAISE EXCEPTION 'SOL-17 preflight: migration ledger checksum is unexpected';
  END IF;
  IF target_tables<>3 OR target_triggers<>3 OR to_regprocedure('public.fn_commercial_evidence_append_only()') IS NULL THEN
    RAISE EXCEPTION 'SOL-17 preflight: applied migration shape is incomplete';
  END IF;
END
$preflight$;

ROLLBACK;
