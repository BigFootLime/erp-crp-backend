-- #767 / L5: actual withdrawals, reusable remnants and audited transfer changes.
BEGIN;
ALTER TABLE public.production_material_debits ALTER CONSTRAINT production_material_debits_declaration_id_fkey DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.production_material_debit_sources
  ADD COLUMN IF NOT EXISTS planned_qty numeric(18,3),
  ADD COLUMN IF NOT EXISTS actual_qty numeric(18,3);
ALTER TABLE public.production_material_debit_sources ADD CONSTRAINT production_material_debit_sources_measured_pair_chk CHECK(
  (planned_qty IS NULL AND actual_qty IS NULL) OR
  (planned_qty IS NOT NULL AND actual_qty IS NOT NULL AND abs(actual_qty)<1e15 AND abs(planned_qty)<1e15 AND
    ((planned_qty>=0 AND actual_qty>0) OR (planned_qty<=0 AND actual_qty<0))));
CREATE TABLE IF NOT EXISTS public.production_material_remnants(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  debit_id uuid NOT NULL REFERENCES public.production_material_debits(id) ON DELETE RESTRICT,
  source_reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL UNIQUE REFERENCES public.lots(id) ON DELETE RESTRICT,
  stock_movement_id uuid NOT NULL UNIQUE REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  unit text NOT NULL,
  dimensions jsonb NOT NULL CHECK(jsonb_typeof(dimensions)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.production_material_transfer_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES public.production_transfer_batches(id) ON DELETE RESTRICT,
  command_key uuid NOT NULL REFERENCES public.of_material_commands(idempotency_key) DEFERRABLE INITIALLY DEFERRED,
  action text NOT NULL CHECK(action IN ('RELEASE','RETURN')),
  quantity numeric(18,3) NOT NULL CHECK(quantity>0),
  reason text NOT NULL CHECK(length(btrim(reason))>=10),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  UNIQUE(transfer_id,command_key)
);
CREATE TRIGGER production_material_remnants_immutable BEFORE UPDATE OR DELETE ON public.production_material_remnants FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER production_material_transfer_events_immutable BEFORE UPDATE OR DELETE ON public.production_material_transfer_events FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.production_material_remnants OWNER TO cerp_app;
ALTER TABLE public.production_material_transfer_events OWNER TO cerp_app;
COMMIT;
