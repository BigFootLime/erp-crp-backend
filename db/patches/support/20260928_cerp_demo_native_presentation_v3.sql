-- CERP demo only: native client and quote forms adopt their own confirmed writes.
BEGIN;
DO $$
DECLARE constraint_name text;
BEGIN
  IF current_database() <> 'cerp_demo' THEN
    RAISE EXCEPTION 'This patch is restricted to cerp_demo (current: %)', current_database();
  END IF;
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'public.demo_presentation_scenarios'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%QUOTE_DRAFT%'
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Presentation scenario status constraint is missing';
  END IF;
  EXECUTE format('ALTER TABLE public.demo_presentation_scenarios DROP CONSTRAINT %I', constraint_name);
  ALTER TABLE public.demo_presentation_scenarios
    ADD CONSTRAINT demo_presentation_scenarios_status_check CHECK (status IN (
      'INITIALIZING','CLIENT_PREPARED','CLIENT_CREATED','QUOTE_PREPARED','QUOTE_DRAFT',
      'COMMANDE_CREATED','AFFAIRE_CREATED','PRODUCTION_READY','PLANNED','OPERATOR_READY','RUNNING',
      'PAUSED','QUANTITY_DECLARED','COMPLETED'
    ));
END $$;
COMMIT;
