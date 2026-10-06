-- #815: provenance for physical holds moved to a consolidated producer.
BEGIN;
ALTER TABLE public.ordres_fabrication ADD COLUMN IF NOT EXISTS material_origin_limit smallint NOT NULL DEFAULT 2
  CHECK(material_origin_limit IN (1,2));
UPDATE public.ordres_fabrication o SET material_origin_limit=1 FROM public.pieces_techniques pt
  WHERE pt.id=o.piece_technique_id AND pt.piece_critique AND o.material_origin_limit<>1;
CREATE OR REPLACE FUNCTION public.fn_freeze_of_material_origin_limit_815() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.pieces_techniques WHERE id=NEW.piece_technique_id AND piece_critique)
    OR NEW.technical_snapshot->'piece'->>'piece_critique'='true' THEN NEW.material_origin_limit:=1; END IF;
  IF TG_OP='UPDATE' THEN NEW.material_origin_limit:=LEAST(OLD.material_origin_limit,NEW.material_origin_limit); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER of_material_origin_limit_815 BEFORE INSERT OR UPDATE ON public.ordres_fabrication
  FOR EACH ROW EXECUTE FUNCTION public.fn_freeze_of_material_origin_limit_815();
CREATE TABLE IF NOT EXISTS public.production_consolidation_material_transfers (
  consolidation_id uuid NOT NULL REFERENCES public.production_consolidations(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  source_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  source_need_id uuid NOT NULL REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  producer_need_id uuid NOT NULL REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(consolidation_id,reservation_id)
);
CREATE TRIGGER production_consolidation_material_transfers_immutable BEFORE UPDATE OR DELETE
  ON public.production_consolidation_material_transfers FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.production_consolidation_material_transfers OWNER TO cerp_app;
ALTER FUNCTION public.fn_freeze_of_material_origin_limit_815() OWNER TO cerp_app;
COMMIT;
