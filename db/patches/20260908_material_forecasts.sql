-- Durable invalidation across owning modules, projection separate from commitments.
BEGIN;
ALTER TABLE public.planning_tasks ADD COLUMN IF NOT EXISTS forecast_issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(forecast_issues)='array');
CREATE TABLE IF NOT EXISTS public.planning_forecast_state(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  calculated_at timestamptz,source_revision bigint,issue_count integer NOT NULL DEFAULT 0,last_error text
);
INSERT INTO public.planning_forecast_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE public.planning_forecast_state OWNER TO cerp_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['lots','stock_batches','stock_movements','quality_control','quality_release_decision','quality_control_plan','non_conformity',
    'commande_fournisseur','commande_fournisseur_ligne','commande_fournisseur_ligne_besoin','receptions_fournisseurs','reception_fournisseur_lignes',
    'of_material_needs','of_material_lot_checks','of_customer_material_calls','of_material_revision_resolutions','of_dossier_validations','ged_document_versions'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS planning_invalidate ON public.%I',t);
      EXECUTE format('CREATE TRIGGER planning_invalidate AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate()',t);
    END IF;
  END LOOP;
END $$;
INSERT INTO public.planning_recalculation_jobs(entity_table,entity_id,source_revision)
  SELECT 'planning_forecast_state','initial',revision FROM public.planning_central_settings WHERE singleton;
COMMIT;
