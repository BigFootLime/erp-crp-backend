BEGIN;

CREATE TABLE IF NOT EXISTS public.production_consolidation_reservation_restorations (
  consolidation_id uuid NOT NULL REFERENCES public.production_consolidations(id) ON DELETE RESTRICT,
  original_reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  replacement_reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  restored_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  restored_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consolidation_id, original_reservation_id),
  UNIQUE (replacement_reservation_id),
  CHECK (original_reservation_id <> replacement_reservation_id)
);

CREATE TRIGGER production_consolidation_reservation_restorations_immutable
  BEFORE UPDATE OR DELETE ON public.production_consolidation_reservation_restorations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();

ALTER TABLE public.production_consolidation_reservation_restorations OWNER TO cerp_app;
GRANT SELECT,INSERT ON public.production_consolidation_reservation_restorations TO cerp_app;
COMMIT;
