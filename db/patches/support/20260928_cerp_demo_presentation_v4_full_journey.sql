-- CERP demo only: scenario registry for the native end-to-end presentation.
-- This patch records links between writes made through the normal UI/API; it
-- never creates, changes, or deletes business objects itself.
BEGIN;

DO $$
DECLARE constraint_name text;
BEGIN
  IF current_database() <> 'cerp_demo' THEN
    RAISE EXCEPTION 'This patch is restricted to cerp_demo (current: %)', current_database();
  END IF;
  IF to_regclass('public.demo_presentation_scenarios') IS NULL THEN
    RAISE EXCEPTION 'Presentation scenario registry is missing';
  END IF;

  ALTER TABLE public.demo_presentation_scenarios
    ALTER COLUMN piece_technique_id DROP NOT NULL,
    ALTER COLUMN piece_technique_version_id DROP NOT NULL,
    ALTER COLUMN machine_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS gamme_id uuid NULL REFERENCES public.gammes(id),
    ADD COLUMN IF NOT EXISTS article_id uuid NULL REFERENCES public.articles(id),
    ADD COLUMN IF NOT EXISTS receipt_id uuid NULL REFERENCES public.of_receipts(id),
    ADD COLUMN IF NOT EXISTS lot_id uuid NULL REFERENCES public.lots(id),
    ADD COLUMN IF NOT EXISTS stock_movement_id uuid NULL REFERENCES public.stock_movements(id),
    ADD COLUMN IF NOT EXISTS reservation_id uuid NULL REFERENCES public.stock_reservations(id),
    ADD COLUMN IF NOT EXISTS quality_control_id uuid NULL REFERENCES public.quality_control(id),
    ADD COLUMN IF NOT EXISTS quality_release_decision_id uuid NULL REFERENCES public.quality_release_decision(id),
    ADD COLUMN IF NOT EXISTS livraison_id uuid NULL REFERENCES public.bon_livraison(id);

  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'public.demo_presentation_scenarios'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%QUOTE_DRAFT%'
   ORDER BY oid
   LIMIT 1;
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'Presentation scenario status constraint is missing';
  END IF;
  EXECUTE format('ALTER TABLE public.demo_presentation_scenarios DROP CONSTRAINT %I', constraint_name);
  ALTER TABLE public.demo_presentation_scenarios
    ADD CONSTRAINT demo_presentation_scenarios_status_check CHECK (status IN (
      'INITIALIZING','CLIENT_PREPARED','CLIENT_CREATED',
      'PIECE_PREPARED','PIECE_CREATED','GAMME_PREPARED','GAMME_APPLICABLE',
      'ARTICLE_PREPARED','ARTICLE_CREATED','QUOTE_PREPARED','QUOTE_DRAFT',
      'COMMANDE_CREATED','AFFAIRE_CREATED','PRODUCTION_READY','PLANNED',
      'OPERATOR_READY','RUNNING','PAUSED','QUANTITY_DECLARED',
      'OPERATION_FINISHED','OF_FINISHED','RECEIPT_PREPARED','RECEIPTED',
      'QUALITY_RELEASE_PREPARED','QUALITY_RELEASED','DELIVERY_PREPARED',
      'DELIVERY_CREATED','SHIPPED','COMPLETED'
    ));
END $$;

CREATE INDEX IF NOT EXISTS demo_presentation_scenarios_article_idx
  ON public.demo_presentation_scenarios(article_id) WHERE article_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS demo_presentation_scenarios_livraison_idx
  ON public.demo_presentation_scenarios(livraison_id) WHERE livraison_id IS NOT NULL;

COMMIT;
