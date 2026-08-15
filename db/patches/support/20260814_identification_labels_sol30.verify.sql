DO $verify$
DECLARE
  missing text[] := ARRAY[]::text[];
  immutable_triggers integer;
  invalid bigint;
BEGIN
  IF to_regclass('public.identification_labels') IS NULL THEN missing := array_append(missing, 'identification_labels'); END IF;
  IF to_regclass('public.identification_print_events') IS NULL THEN missing := array_append(missing, 'identification_print_events'); END IF;
  IF to_regclass('public.identification_scan_events') IS NULL THEN missing := array_append(missing, 'identification_scan_events'); END IF;
  IF to_regclass('public.identification_command_receipts') IS NULL THEN missing := array_append(missing, 'identification_command_receipts'); END IF;
  IF to_regclass('public.identification_audit_events') IS NULL THEN missing := array_append(missing, 'identification_audit_events'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'SOL-30 verify: missing relation(s): %', array_to_string(missing, ', ');
  END IF;

  SELECT count(*) INTO invalid FROM public.identification_labels
  WHERE contract_version <> 1 OR btrim(entity_id) = '' OR btrim(human_code) = '';
  IF invalid > 0 THEN RAISE EXCEPTION 'SOL-30 verify: % invalid label row(s)', invalid; END IF;

  SELECT count(*) INTO invalid
  FROM public.identification_labels a
  JOIN public.identification_labels b
    ON b.entity_type = a.entity_type AND b.entity_id = a.entity_id AND b.id <> a.id
  WHERE a.status = 'ACTIVE' AND b.status = 'ACTIVE';
  IF invalid > 0 THEN RAISE EXCEPTION 'SOL-30 verify: duplicate active labels detected'; END IF;

  SELECT count(*) INTO immutable_triggers FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_identification_print_events_immutable_sol30',
    'trg_identification_scan_events_immutable_sol30',
    'trg_identification_receipts_immutable_sol30',
    'trg_identification_audit_immutable_sol30'
  );
  IF immutable_triggers <> 4 THEN RAISE EXCEPTION 'SOL-30 verify: immutable evidence triggers are incomplete'; END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AND (
    NOT has_table_privilege('cerp_app', 'public.identification_labels', 'SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app', 'public.identification_scan_events', 'SELECT,INSERT')
    OR NOT has_table_privilege('cerp_app', 'public.identification_audit_events', 'SELECT,INSERT')
  ) THEN RAISE EXCEPTION 'SOL-30 verify: cerp_app grants are invalid'; END IF;
END
$verify$;

BEGIN;
DO $verify_immutable_runtime$
DECLARE
  actor integer;
  probe_label uuid;
  probe_event bigint;
  rejected boolean := false;
BEGIN
  SELECT id INTO actor FROM public.users ORDER BY id LIMIT 1;
  IF actor IS NULL THEN RETURN; END IF;
  INSERT INTO public.identification_labels(entity_type,entity_id,human_code,issued_by)
  VALUES ('STOCK_ARTICLE','sol30-rollback-probe','SOL30-PROBE',actor)
  RETURNING id INTO probe_label;
  INSERT INTO public.identification_audit_events(actor_user_id,action,entity_type,entity_id,label_id,details)
  VALUES (actor,'SOL30_VERIFY_PROBE','STOCK_ARTICLE','sol30-rollback-probe',probe_label,'{"probe":true}'::jsonb)
  RETURNING id INTO probe_event;
  BEGIN
    UPDATE public.identification_audit_events SET details='{"probe":false}'::jsonb WHERE id=probe_event;
  EXCEPTION WHEN SQLSTATE '55000' THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'SOL-30 verify: immutable audit trigger did not reject an update'; END IF;
END
$verify_immutable_runtime$;
ROLLBACK;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.identification_labels) AS labels,
       (SELECT count(*) FROM public.identification_scan_events) AS scan_events,
       (SELECT count(*) FROM public.identification_print_events) AS print_events,
       now() AS verified_at;
