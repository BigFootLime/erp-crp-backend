DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['client_crm_profiles','client_crm_followups','client_crm_events'] LOOP
    IF to_regclass('public.'||target) IS NULL OR NOT has_table_privilege('cerp_app','public.'||target,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||target,'INSERT')
      OR has_table_privilege('cerp_app','public.'||target,'DELETE')
      OR has_table_privilege('cerp_app','public.'||target,'TRUNCATE') THEN
      RAISE EXCEPTION 'CRM table or grants invalid: %',target;
    END IF;
  END LOOP;
  IF has_table_privilege('cerp_app','public.client_crm_events','UPDATE') OR NOT EXISTS(
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.client_crm_events'::regclass AND tgname='client_crm_events_guard' AND NOT tgisinternal
  ) THEN RAISE EXCEPTION 'CRM history must be immutable'; END IF;
  IF to_regclass('public.client_crm_followups_due_idx') IS NULL OR to_regclass('public.client_crm_events_client_idx') IS NULL THEN
    RAISE EXCEPTION 'CRM indexes missing';
  END IF;
END $$;
