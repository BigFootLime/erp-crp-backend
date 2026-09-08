\set ON_ERROR_STOP on
SELECT documents FROM public.supplier_consultation_invitations LIMIT 0;
DO $$ BEGIN
  IF NOT has_column_privilege('cerp_app','public.supplier_consultation_invitations','documents','SELECT,INSERT') THEN
    RAISE EXCEPTION 'Missing consultation document privileges';
  END IF;
END $$;
