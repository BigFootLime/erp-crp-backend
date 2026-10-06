-- L4 / #822. Additive, immutable debit and definitive-loss proofs.
BEGIN;
ALTER TABLE public.production_material_debit_sources ADD COLUMN IF NOT EXISTS cut_qty numeric;
ALTER TABLE public.production_material_debit_sources ADD COLUMN IF NOT EXISTS discarded_qty numeric;
ALTER TABLE public.production_material_debit_sources ADD COLUMN IF NOT EXISTS extended_qty numeric;
ALTER TABLE public.production_material_debit_sources ADD COLUMN IF NOT EXISTS bar_closed boolean NOT NULL DEFAULT false;
ALTER TABLE public.production_material_debits ADD COLUMN IF NOT EXISTS quantity_kind text NOT NULL DEFAULT 'ACTUAL';
CREATE TABLE IF NOT EXISTS public.production_loss_complements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  source_operation_id uuid NOT NULL REFERENCES public.of_operations(id),
  complement_of_id bigint NOT NULL UNIQUE REFERENCES public.ordres_fabrication(id),
  quantity numeric NOT NULL CHECK(quantity>0),
  loss_snapshot jsonb NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason))>=10),
  request_key uuid NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_loss_complements_source_idx ON public.production_loss_complements(source_of_id,source_operation_id);
CREATE OR REPLACE TRIGGER production_loss_complements_immutable BEFORE UPDATE OR DELETE ON public.production_loss_complements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.production_loss_complements OWNER TO cerp_app;
GRANT SELECT,INSERT ON public.production_loss_complements TO cerp_app;
CREATE OR REPLACE FUNCTION public.guard_covered_production_loss() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE covered numeric; remaining_loss numeric;
BEGIN
  IF NEW.qty_scrap>=0 OR NEW.operation_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(c.quantity),0) INTO covered FROM public.production_loss_complements c
    JOIN public.ordres_fabrication f ON f.id=c.complement_of_id WHERE c.source_operation_id=NEW.operation_id AND f.statut::text<>'ANNULE';
  IF covered=0 THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(qty_scrap),0) INTO remaining_loss FROM public.production_quantity_declarations WHERE operation_id=NEW.operation_id;
  IF remaining_loss<covered THEN RAISE EXCEPTION 'Definitive losses already covered by a complement; cancel its unused draft before correction' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER production_covered_loss_guard AFTER INSERT ON public.production_quantity_declarations
  FOR EACH ROW EXECUTE FUNCTION public.guard_covered_production_loss();
ALTER FUNCTION public.guard_covered_production_loss() OWNER TO cerp_app;
COMMIT;
