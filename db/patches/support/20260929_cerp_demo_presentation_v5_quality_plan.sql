-- CERP demo only: visible quality-plan stage for the native presentation.
BEGIN;
DO $$
DECLARE constraint_name text;
BEGIN
  IF current_database() <> 'cerp_demo' THEN RAISE EXCEPTION 'This patch is restricted to cerp_demo (current: %)', current_database(); END IF;
  ALTER TABLE public.demo_presentation_scenarios
    ADD COLUMN IF NOT EXISTS quality_plan_id uuid NULL REFERENCES public.quality_control_plan(id);
  SELECT conname INTO constraint_name FROM pg_constraint
   WHERE conrelid='public.demo_presentation_scenarios'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%QUALITY_RELEASE_PREPARED%'
   ORDER BY oid LIMIT 1;
  IF constraint_name IS NULL THEN RAISE EXCEPTION 'Presentation scenario status constraint is missing'; END IF;
  EXECUTE format('ALTER TABLE public.demo_presentation_scenarios DROP CONSTRAINT %I', constraint_name);
  ALTER TABLE public.demo_presentation_scenarios ADD CONSTRAINT demo_presentation_scenarios_status_check CHECK (status IN (
    'INITIALIZING','CLIENT_PREPARED','CLIENT_CREATED','PIECE_PREPARED','PIECE_CREATED','GAMME_PREPARED','GAMME_APPLICABLE','ARTICLE_PREPARED','ARTICLE_CREATED','QUOTE_PREPARED','QUOTE_DRAFT','COMMANDE_CREATED','AFFAIRE_CREATED','PRODUCTION_READY','PLANNED','OPERATOR_READY','RUNNING','PAUSED','QUANTITY_DECLARED','OPERATION_FINISHED','OF_FINISHED','RECEIPT_PREPARED','RECEIPTED','DELIVERY_PREPARED','DELIVERY_CREATED','QUALITY_PLAN_PREPARED','QUALITY_PLAN_PUBLISHED','QUALITY_RELEASE_PREPARED','QUALITY_RELEASED','SHIPPED','COMPLETED'
  ));
END $$;
CREATE INDEX IF NOT EXISTS demo_presentation_scenarios_quality_plan_idx ON public.demo_presentation_scenarios(quality_plan_id) WHERE quality_plan_id IS NOT NULL;
COMMIT;
