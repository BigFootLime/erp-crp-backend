DO $verify$
DECLARE
  missing_relations text[] := ARRAY[]::text[];
  invalid_rows bigint;
  immutable_triggers integer;
BEGIN
  IF to_regclass('public.api_webhook_subscriptions') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_subscriptions'); END IF;
  IF to_regclass('public.api_webhook_events') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_events'); END IF;
  IF to_regclass('public.api_webhook_deliveries') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_deliveries'); END IF;
  IF to_regclass('public.api_webhook_delivery_attempts') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_delivery_attempts'); END IF;
  IF to_regclass('public.api_webhook_command_receipts') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_command_receipts'); END IF;
  IF to_regclass('public.api_webhook_audit_events') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_audit_events'); END IF;
  IF to_regclass('public.api_webhook_ingestion_state') IS NULL THEN missing_relations := array_append(missing_relations, 'api_webhook_ingestion_state'); END IF;
  IF cardinality(missing_relations) > 0 THEN
    RAISE EXCEPTION 'SOL-28 verify: missing relation(s): %', array_to_string(missing_relations, ', ');
  END IF;

  SELECT count(*) INTO invalid_rows FROM (
    SELECT id FROM public.api_webhook_subscriptions
    WHERE cardinality(event_types) = 0 OR secret_ciphertext = '' OR secret_iv = '' OR secret_tag = ''
    UNION ALL
    SELECT id FROM public.api_webhook_events
    WHERE payload_sha256 !~ '^[0-9a-f]{64}$' OR jsonb_typeof(payload) <> 'object'
    UNION ALL
    SELECT id FROM public.api_webhook_deliveries
    WHERE (status = 'PROCESSING') <> (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ) invalid;
  IF invalid_rows > 0 THEN RAISE EXCEPTION 'SOL-28 verify: % invalid row(s)', invalid_rows; END IF;

  SELECT count(*) INTO immutable_triggers
  FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_api_webhook_attempts_immutable_sol28',
    'trg_api_webhook_receipts_immutable_sol28',
    'trg_api_webhook_audit_immutable_sol28'
  );
  IF immutable_triggers <> 3 THEN RAISE EXCEPTION 'SOL-28 verify: immutable evidence triggers are incomplete'; END IF;

  IF (SELECT count(*) FROM public.api_webhook_ingestion_state WHERE singleton) <> 1 THEN
    RAISE EXCEPTION 'SOL-28 verify: ingestion cursor is missing or duplicated';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AND (
    NOT has_table_privilege('cerp_app', 'public.api_webhook_subscriptions', 'SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app', 'public.api_webhook_deliveries', 'SELECT,INSERT,UPDATE')
    OR has_table_privilege('cerp_app', 'public.api_webhook_audit_events', 'UPDATE,DELETE')
  ) THEN
    RAISE EXCEPTION 'SOL-28 verify: cerp_app grants are invalid';
  END IF;
END
$verify$;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.api_webhook_subscriptions) AS subscriptions,
       (SELECT count(*) FROM public.api_webhook_events) AS events,
       (SELECT count(*) FROM public.api_webhook_deliveries) AS deliveries,
       (SELECT count(*) FROM public.api_webhook_delivery_attempts) AS attempts,
       (SELECT count(*) FROM public.api_webhook_audit_events) AS audit_events,
       now() AS verified_at;
