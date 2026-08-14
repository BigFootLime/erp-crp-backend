DO $verify$
DECLARE
  missing text[] := ARRAY[]::text[];
  invalid bigint;
  immutable_triggers integer;
  tenant_guard_triggers integer;
BEGIN
  IF to_regclass('public.client_portal_accounts') IS NULL THEN missing := array_append(missing, 'client_portal_accounts'); END IF;
  IF to_regclass('public.client_portal_tokens') IS NULL THEN missing := array_append(missing, 'client_portal_tokens'); END IF;
  IF to_regclass('public.client_portal_command_receipts') IS NULL THEN missing := array_append(missing, 'client_portal_command_receipts'); END IF;
  IF to_regclass('public.client_portal_publications') IS NULL THEN missing := array_append(missing, 'client_portal_publications'); END IF;
  IF to_regclass('public.client_portal_acknowledgements') IS NULL THEN missing := array_append(missing, 'client_portal_acknowledgements'); END IF;
  IF to_regclass('public.client_portal_audit_events') IS NULL THEN missing := array_append(missing, 'client_portal_audit_events'); END IF;
  IF to_regclass('public.client_portal_auth_attempts') IS NULL THEN missing := array_append(missing, 'client_portal_auth_attempts'); END IF;
  IF to_regclass('public.client_portal_orders_v') IS NULL THEN missing := array_append(missing, 'client_portal_orders_v'); END IF;
  IF to_regclass('public.client_portal_deliveries_v') IS NULL THEN missing := array_append(missing, 'client_portal_deliveries_v'); END IF;
  IF to_regclass('public.client_portal_invoices_v') IS NULL THEN missing := array_append(missing, 'client_portal_invoices_v'); END IF;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'SOL-29 verify: missing relation(s): %', array_to_string(missing, ', ');
  END IF;

  SELECT count(*) INTO invalid FROM public.client_portal_accounts a
  LEFT JOIN public.clients c ON c.client_id = a.client_id
  WHERE c.client_id IS NULL OR a.email_normalized <> lower(btrim(a.email_normalized)) OR a.session_epoch < 0;
  IF invalid > 0 THEN RAISE EXCEPTION 'SOL-29 verify: % invalid portal account row(s)', invalid; END IF;

  SELECT count(*) INTO invalid
  FROM public.client_portal_acknowledgements ack
  JOIN public.client_portal_accounts account ON account.id = ack.account_id
  JOIN public.client_portal_publications publication ON publication.id = ack.publication_id
  WHERE account.client_id <> publication.client_id;
  IF invalid > 0 THEN RAISE EXCEPTION 'SOL-29 verify: % cross-client acknowledgement row(s)', invalid; END IF;

  SELECT count(*) INTO immutable_triggers
  FROM pg_trigger
  WHERE NOT tgisinternal AND tgname IN (
    'trg_client_portal_receipts_immutable_sol29',
    'trg_client_portal_ack_immutable_sol29',
    'trg_client_portal_audit_immutable_sol29'
  );
  IF immutable_triggers <> 3 THEN
    RAISE EXCEPTION 'SOL-29 verify: immutable evidence triggers are incomplete';
  END IF;

  SELECT count(*) INTO tenant_guard_triggers
  FROM pg_trigger
  WHERE NOT tgisinternal AND tgname = 'trg_client_portal_ack_tenant_guard_sol29';
  IF tenant_guard_triggers <> 1 THEN
    RAISE EXCEPTION 'SOL-29 verify: acknowledgement tenant guard is missing';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AND (
    NOT has_table_privilege('cerp_app', 'public.client_portal_accounts', 'SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app', 'public.client_portal_publications', 'SELECT,INSERT,UPDATE')
    OR NOT has_table_privilege('cerp_app', 'public.client_portal_audit_events', 'SELECT,INSERT')
    OR NOT has_table_privilege('cerp_app', 'public.client_portal_orders_v', 'SELECT')
  ) THEN
    RAISE EXCEPTION 'SOL-29 verify: cerp_app grants are invalid';
  END IF;
END
$verify$;

BEGIN;
DO $verify_immutable_runtime$
DECLARE
  probe_id bigint;
  rejected boolean := false;
BEGIN
  INSERT INTO public.client_portal_audit_events(action, entity_type, entity_id, details)
  VALUES ('SOL29_VERIFY_PROBE', 'portal_probe', 'rolled-back', '{"probe":true}'::jsonb)
  RETURNING id INTO probe_id;
  BEGIN
    UPDATE public.client_portal_audit_events SET details = '{"probe":false}'::jsonb WHERE id = probe_id;
  EXCEPTION WHEN SQLSTATE '55000' THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'SOL-29 verify: immutable audit trigger did not reject an update'; END IF;
END
$verify_immutable_runtime$;
ROLLBACK;

BEGIN;
DO $verify_ack_tenant_guard_runtime$
DECLARE
  first_client varchar(3);
  second_client varchar(3);
  actor integer;
  first_account uuid;
  second_account uuid;
  publication uuid;
  probe_version_id uuid;
  first_email text;
  second_email text;
  rejected boolean := false;
BEGIN
  SELECT min(client_id), max(client_id) INTO first_client, second_client FROM public.clients;
  SELECT id INTO actor FROM public.users ORDER BY id LIMIT 1;
  SELECT id INTO probe_version_id FROM public.ged_document_versions ORDER BY created_at, id LIMIT 1;
  IF first_client IS NULL OR second_client IS NULL OR first_client = second_client OR actor IS NULL OR probe_version_id IS NULL THEN
    RETURN;
  END IF;
  first_email := format('sol29-guard-a-%s@invalid.example', txid_current());
  second_email := format('sol29-guard-b-%s@invalid.example', txid_current());
  INSERT INTO public.client_portal_accounts(
    client_id,email,email_normalized,display_name,password_hash,status,created_by,updated_by
  ) VALUES (
    first_client,first_email,first_email,'SOL29 Guard A',repeat('x',60),'INVITED',actor,actor
  ) RETURNING id INTO first_account;
  INSERT INTO public.client_portal_accounts(
    client_id,email,email_normalized,display_name,password_hash,status,created_by,updated_by
  ) VALUES (
    second_client,second_email,second_email,'SOL29 Guard B',repeat('x',60),'INVITED',actor,actor
  ) RETURNING id INTO second_account;
  INSERT INTO public.client_portal_publications(client_id,version_id,title_override,published_by)
  VALUES (first_client,probe_version_id,'SOL29 tenant guard probe',actor)
  ON CONFLICT DO NOTHING
  RETURNING id INTO publication;
  IF publication IS NULL THEN
    SELECT id INTO publication
     FROM public.client_portal_publications
     WHERE client_id=first_client AND client_portal_publications.version_id=probe_version_id
     LIMIT 1;
  END IF;
  IF publication IS NULL THEN RAISE EXCEPTION 'SOL-29 verify: tenant guard probe publication unavailable'; END IF;
  BEGIN
    INSERT INTO public.client_portal_acknowledgements(publication_id,account_id)
    VALUES (publication,second_account);
  EXCEPTION WHEN SQLSTATE '42501' THEN rejected := true;
  END;
  IF NOT rejected THEN
    RAISE EXCEPTION 'SOL-29 verify: cross-client acknowledgement was accepted';
  END IF;
END
$verify_ack_tenant_guard_runtime$;
ROLLBACK;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.client_portal_accounts) AS accounts,
       (SELECT count(*) FROM public.client_portal_publications) AS publications,
       (SELECT count(*) FROM public.client_portal_acknowledgements) AS acknowledgements,
       (SELECT count(*) FROM public.client_portal_audit_events) AS audit_events,
       now() AS verified_at;
