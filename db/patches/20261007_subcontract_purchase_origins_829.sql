-- L5: one supplier purchase line per material origin and canonical operation.
BEGIN;
CREATE TABLE IF NOT EXISTS public.subcontract_purchase_origins (
  line_id uuid PRIMARY KEY REFERENCES public.commande_fournisseur_ligne(id),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  operation_id uuid NOT NULL REFERENCES public.of_operations(id),
  material_origin_id uuid REFERENCES public.lots(id),
  preparation_snapshot jsonb NOT NULL,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subcontract_purchase_origins_operation_idx ON public.subcontract_purchase_origins(operation_id,material_origin_id);
CREATE OR REPLACE TRIGGER subcontract_purchase_origins_immutable BEFORE UPDATE OR DELETE ON public.subcontract_purchase_origins
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.subcontract_purchase_origins OWNER TO cerp_app;
GRANT SELECT,INSERT ON public.subcontract_purchase_origins TO cerp_app;
COMMIT;
