-- Explicit declared manufacturing cost bases; no entry, allocation or activation.
BEGIN;
SET LOCAL lock_timeout='10s';
CREATE TABLE public.stock_valuation_manufacturing_bases (
  id uuid PRIMARY KEY,
  of_id bigint NOT NULL UNIQUE REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  margin_snapshot_id uuid NOT NULL REFERENCES public.margin_recalculations(id) ON DELETE RESTRICT,
  quantity_good numeric(38,12) NOT NULL CHECK(quantity_good>0 AND quantity_good<>'NaN'::numeric),
  total_cost_ht numeric(38,12) NOT NULL CHECK(total_cost_ht>=0 AND total_cost_ht<>'NaN'::numeric),
  currency text NOT NULL CHECK(currency='EUR'),
  source_reliability text NOT NULL CHECK(source_reliability='DECLARED'),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object' AND octet_length(source_snapshot::text)<=2097152),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  request_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION public.fn_stock_manufacturing_basis_guard_998() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Declared manufacturing bases are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NEW.source_snapshot->>'schema_version' IS DISTINCT FROM '1'
    OR NEW.source_snapshot#>>'{of,id}' IS DISTINCT FROM NEW.of_id::text
    OR NEW.source_snapshot#>>'{margin,id}' IS DISTINCT FROM NEW.margin_snapshot_id::text
    OR NEW.source_snapshot#>>'{margin,basis}' IS DISTINCT FROM 'ACTUAL'
    OR NEW.source_snapshot#>>'{margin,scope_type}' IS DISTINCT FROM 'OF'
    OR NEW.source_snapshot#>>'{margin,scope_ref}' IS DISTINCT FROM NEW.of_id::text
    OR NEW.source_snapshot#>>'{margin,result_snapshot,currency}' IS DISTINCT FROM NEW.currency
    OR (NEW.source_snapshot->>'good_quantity')::numeric IS DISTINCT FROM NEW.quantity_good
    OR (NEW.source_snapshot#>>'{margin,result_snapshot,cost_total_ht}')::numeric IS DISTINCT FROM NEW.total_cost_ht
    OR NOT EXISTS(SELECT 1 FROM public.margin_recalculations m WHERE m.id=NEW.margin_snapshot_id
      AND m.scope_type='OF' AND m.scope_ref=NEW.of_id::text AND m.basis='ACTUAL'
      AND to_jsonb(m)=NEW.source_snapshot->'margin') THEN
    RAISE EXCEPTION 'Manufacturing basis must reference its unchanged saved ACTUAL cost' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_manufacturing_bases_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_manufacturing_bases FOR EACH ROW EXECUTE FUNCTION public.fn_stock_manufacturing_basis_guard_998();
CREATE TRIGGER stock_manufacturing_bases_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_manufacturing_bases FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_manufacturing_basis_guard_998();
ALTER TABLE public.stock_valuation_manufacturing_bases OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_basis_guard_998() OWNER TO cerp_app;
COMMIT;
