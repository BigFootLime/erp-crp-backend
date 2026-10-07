DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients'
    AND column_name='client_id' AND udt_name IN('varchar','text')) THEN
    RAISE EXCEPTION 'Canonical client varchar identity required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts'
    AND column_name='contact_id' AND udt_name='uuid') THEN RAISE EXCEPTION 'Canonical contact UUID required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN RAISE EXCEPTION 'Runtime role missing'; END IF;
END $$;
