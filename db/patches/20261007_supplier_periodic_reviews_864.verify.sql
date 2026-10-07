DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['supplier_review_scopes','supplier_review_policies','supplier_review_evaluations','supplier_review_commands'] LOOP
  IF to_regclass('public.'||t) IS NULL OR NOT has_table_privilege('cerp_app','public.'||t,'SELECT') OR NOT has_table_privilege('cerp_app','public.'||t,'INSERT') OR has_table_privilege('cerp_app','public.'||t,'UPDATE') OR has_table_privilege('cerp_app','public.'||t,'DELETE') OR has_table_privilege('cerp_app','public.'||t,'TRUNCATE')
  THEN RAISE EXCEPTION 'SUPPLIER_REVIEW_PRIVILEGES_INVALID: %',t; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('supplier_review_scopes_immutable_864','supplier_review_policies_immutable_864','supplier_review_evaluations_immutable_864','supplier_review_commands_immutable_864') AND NOT tgisinternal AND tgenabled<>'D')<>4 THEN RAISE EXCEPTION 'SUPPLIER_REVIEW_IMMUTABILITY_INVALID'; END IF;
END $$;
