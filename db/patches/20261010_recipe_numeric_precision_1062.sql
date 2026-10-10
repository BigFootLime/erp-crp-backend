-- #1062 — retain fractional unit prices and method/OF durations.
-- Widen precision only: no historical amount, duration or frozen dossier is recalculated.
-- The transaction restores the active-execution view with its definition and permissions.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.pieces_techniques_achats
  ALTER COLUMN prix TYPE numeric(16,6),
  ALTER COLUMN pu_achat TYPE numeric(16,6);
ALTER TABLE public.pieces_techniques_operations
  ALTER COLUMN temps_total TYPE numeric(16,6);

DO $precision$
DECLARE
  view_definition text;
  view_owner name;
  view_options text[];
  view_comment text;
  view_grants jsonb;
  column_comments jsonb;
  grant_record jsonb;
  comment_record jsonb;
  conditional_triggers jsonb;
  trigger_record jsonb;
  privilege_name text;
  grantee text;
BEGIN
  SELECT pg_get_viewdef(c.oid, true), pg_get_userbyid(c.relowner), c.reloptions,
         obj_description(c.oid, 'pg_class')
    INTO STRICT view_definition, view_owner, view_options, view_comment
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='v_production_active_executions' AND c.relkind='v';

  -- Refuse unusual column grants instead of silently removing a security decision.
  IF EXISTS (SELECT 1 FROM pg_attribute
      WHERE attrelid='public.v_production_active_executions'::regclass AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'Active execution view has column grants; explicit migration review required';
  END IF;

  -- Delegated grant chains need an explicit review; preserve their grantor identity.
  IF EXISTS (SELECT 1 FROM pg_class c
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r',c.relowner))) acl
      WHERE c.oid='public.v_production_active_executions'::regclass AND acl.grantor<>c.relowner) THEN
    RAISE EXCEPTION 'Active execution view has delegated grants; explicit migration review required';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('grantee', acl.grantee,
      'privilege', acl.privilege_type, 'grantable', acl.is_grantable)), '[]'::jsonb)
    INTO view_grants
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r',c.relowner))) acl
    WHERE c.oid='public.v_production_active_executions'::regclass AND acl.grantee<>c.relowner;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('column',a.attname,'comment',d.description)), '[]'::jsonb)
    INTO column_comments FROM pg_attribute a JOIN pg_description d
      ON d.objoid=a.attrelid AND d.objsubid=a.attnum AND d.classoid='pg_class'::regclass
    WHERE a.attrelid='public.v_production_active_executions'::regclass AND a.attnum>0 AND NOT a.attisdropped;

  -- PostgreSQL cannot widen a column referenced by a trigger WHEN expression.
  -- Preserve only these dependent triggers, including their original enabled mode.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.of_operations'::regclass
      AND NOT tgisinternal AND tgqual IS NOT NULL AND (tgconstraint<>0 OR tgparentid<>0)) THEN
    RAISE EXCEPTION 'Conditional execution trigger has a constraint or partition parent; review required';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(oid,true),
      'enabled',tgenabled,'comment',obj_description(oid,'pg_trigger'))),'[]'::jsonb)
    INTO conditional_triggers FROM pg_trigger
    WHERE tgrelid='public.of_operations'::regclass AND NOT tgisinternal AND tgqual IS NOT NULL;
  FOR trigger_record IN SELECT value FROM jsonb_array_elements(conditional_triggers) LOOP
    EXECUTE format('DROP TRIGGER %I ON public.of_operations RESTRICT',trigger_record->>'name');
  END LOOP;

  -- RESTRICT deliberately fails if another view depends on this one. No cascade.
  DROP VIEW public.v_production_active_executions RESTRICT;
  ALTER TABLE public.of_operations
    ALTER COLUMN tp TYPE numeric(16,6),
    ALTER COLUMN tf_unit TYPE numeric(16,6),
    ALTER COLUMN temps_total_planned TYPE numeric(16,6),
    ALTER COLUMN temps_total_real TYPE numeric(16,6);

  EXECUTE 'CREATE VIEW public.v_production_active_executions'
    || CASE WHEN view_options IS NULL THEN '' ELSE ' WITH ('||array_to_string(view_options, ', ')||')' END
    || ' AS '||view_definition;
  EXECUTE format('ALTER VIEW public.v_production_active_executions OWNER TO %I',view_owner);

  FOR trigger_record IN SELECT value FROM jsonb_array_elements(conditional_triggers) LOOP
    EXECUTE trigger_record->>'definition';
    EXECUTE format('ALTER TABLE public.of_operations %s TRIGGER %I',
      CASE trigger_record->>'enabled' WHEN 'O' THEN 'ENABLE' WHEN 'R' THEN 'ENABLE REPLICA'
        WHEN 'A' THEN 'ENABLE ALWAYS' WHEN 'D' THEN 'DISABLE' END,trigger_record->>'name');
    EXECUTE format('COMMENT ON TRIGGER %I ON public.of_operations IS %L',
      trigger_record->>'name',trigger_record->>'comment');
  END LOOP;

  -- Remove default privileges inherited during recreation, then restore the exact grants.
  FOR grantee IN
    SELECT CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='public.v_production_active_executions'::regclass AND a.grantee<>c.relowner
    GROUP BY a.grantee
  LOOP
    EXECUTE 'REVOKE ALL ON public.v_production_active_executions FROM '||grantee;
  END LOOP;
  FOR grant_record IN SELECT value FROM jsonb_array_elements(view_grants) LOOP
    privilege_name:=grant_record->>'privilege';
    IF privilege_name NOT IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN') THEN
      RAISE EXCEPTION 'Unexpected view privilege %',privilege_name;
    END IF;
    grantee:=CASE WHEN (grant_record->>'grantee')::oid=0 THEN 'PUBLIC'
      ELSE quote_ident(pg_get_userbyid((grant_record->>'grantee')::oid)) END;
    EXECUTE 'GRANT '||privilege_name||' ON public.v_production_active_executions TO '||grantee
      || CASE WHEN (grant_record->>'grantable')::boolean THEN ' WITH GRANT OPTION' ELSE '' END;
  END LOOP;
  EXECUTE format('COMMENT ON VIEW public.v_production_active_executions IS %L',view_comment);
  FOR comment_record IN SELECT value FROM jsonb_array_elements(column_comments) LOOP
    EXECUTE format('COMMENT ON COLUMN public.v_production_active_executions.%I IS %L',
      comment_record->>'column',comment_record->>'comment');
  END LOOP;
END;
$precision$;
COMMIT;
