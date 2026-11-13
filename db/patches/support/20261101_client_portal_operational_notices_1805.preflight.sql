DO $$ BEGIN IF to_regclass('public.client_portal_delivery_site_bindings') IS NULL THEN RAISE EXCEPTION 'operational notice site-binding prerequisite is missing'; END IF; END $$;
