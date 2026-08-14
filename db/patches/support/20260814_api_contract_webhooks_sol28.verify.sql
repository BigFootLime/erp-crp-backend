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
    OR NOT has_table_privilege('cerp_app', 'public.api_webhook_audit_events', 'SELECT,INSERT')
  ) THEN
    RAISE EXCEPTION 'SOL-28 verify: cerp_app grants are invalid';
  END IF;
END
$verify$;

-- The migration role may own these relations, so ownership legitimately implies
-- UPDATE/DELETE privileges even when those privileges were not explicitly granted.
-- Prove append-only enforcement through the trigger itself, inside a rolled-back
-- transaction, instead of inferring it from has_table_privilege().
BEGIN;
DO $verify_immutable_runtime$
DECLARE
  probe_id bigint;
  immutable_enforced boolean := false;
BEGIN
  INSERT INTO public.api_webhook_audit_events (
    actor_id,
    action,
    entity_type,
    entity_id,
    details
  ) VALUES (
    NULL,
    'SOL28_VERIFY_PROBE',
    'api_webhook_audit_event',
    'rolled-back-probe',
    '{"probe": true}'::jsonb
  )
  RETURNING id INTO probe_id;

  BEGIN
    UPDATE public.api_webhook_audit_events
    SET details = '{"probe": false}'::jsonb
    WHERE id = probe_id;
  EXCEPTION
    WHEN SQLSTATE '55000' THEN
      immutable_enforced := true;
  END;

  IF NOT immutable_enforced THEN
    RAISE EXCEPTION 'SOL-28 verify: immutable audit trigger did not reject an update';
  END IF;
END
$verify_immutable_runtime$;
ROLLBACK;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.api_webhook_subscriptions) AS subscriptions,
       (SELECT count(*) FROM public.api_webhook_events) AS events,
       (SELECT count(*) FROM public.api_webhook_deliveries) AS deliveries,
       (SELECT count(*) FROM public.api_webhook_delivery_attempts) AS attempts,
       (SELECT count(*) FROM public.api_webhook_audit_events) AS audit_events,
       now() AS verified_at;
