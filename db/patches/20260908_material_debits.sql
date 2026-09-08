-- #767 / L5. Link canonical quantities, stock issues and transferable WIP.
-- These tables are proofs, never an additional stock/reservation balance.
BEGIN;
CREATE TABLE IF NOT EXISTS public.production_material_debits(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  technical_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  declaration_id uuid NOT NULL UNIQUE REFERENCES public.production_quantity_declarations(id) ON DELETE RESTRICT,
  command_key uuid NOT NULL UNIQUE REFERENCES public.of_material_commands(idempotency_key) DEFERRABLE INITIALLY DEFERRED,
  source_version text NOT NULL CHECK(source_version ~ '^[a-f0-9]{64}$'),
  note text NOT NULL DEFAULT '',
  compensates_id uuid UNIQUE REFERENCES public.production_material_debits(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS production_material_debits_operation_idx ON public.production_material_debits(operation_id,created_at,id);
CREATE TABLE IF NOT EXISTS public.production_material_debit_sources(
  debit_id uuid NOT NULL REFERENCES public.production_material_debits(id) ON DELETE RESTRICT,
  need_id uuid NOT NULL REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  stock_movement_id uuid NOT NULL UNIQUE REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  PRIMARY KEY(debit_id,reservation_id)
);
ALTER TABLE public.production_transfer_batches ADD COLUMN IF NOT EXISTS material_debit_id uuid REFERENCES public.production_material_debits(id) ON DELETE RESTRICT;
CREATE OR REPLACE FUNCTION public.prevent_material_debit_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Material debit proof is immutable; record a linked correction' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS production_material_debits_immutable ON public.production_material_debits;
CREATE TRIGGER production_material_debits_immutable BEFORE UPDATE OR DELETE ON public.production_material_debits FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
DROP TRIGGER IF EXISTS production_material_debit_sources_immutable ON public.production_material_debit_sources;
CREATE TRIGGER production_material_debit_sources_immutable BEFORE UPDATE OR DELETE ON public.production_material_debit_sources FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
ALTER TABLE public.production_material_debits OWNER TO cerp_app;
ALTER TABLE public.production_material_debit_sources OWNER TO cerp_app;
ALTER FUNCTION public.prevent_material_debit_rewrite() OWNER TO cerp_app;
COMMIT;
