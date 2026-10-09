-- Explicit forecast -> canonical firm call allocations. No order is created by DDL.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.client_contract_forecasts ADD CONSTRAINT client_forecasts_allocation_scope_key UNIQUE(id,contract_id,contract_line_id,unit_id);
ALTER TABLE public.client_contract_call_lines ADD CONSTRAINT client_call_lines_allocation_scope_key UNIQUE(id,contract_id,contract_line_id,unit_id);
CREATE TABLE public.client_forecast_call_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id uuid NOT NULL,
  call_line_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  contract_line_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0 AND quantity<=1000000000),
  forecast_version_before integer NOT NULL CHECK(forecast_version_before>0 AND forecast_version_before<2147483646),
  forecast_snapshot jsonb NOT NULL CHECK(jsonb_typeof(forecast_snapshot)='object'),
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(forecast_id,contract_id,contract_line_id,unit_id)
    REFERENCES public.client_contract_forecasts(id,contract_id,contract_line_id,unit_id) ON DELETE RESTRICT,
  FOREIGN KEY(call_line_id,contract_id,contract_line_id,unit_id)
    REFERENCES public.client_contract_call_lines(id,contract_id,contract_line_id,unit_id) ON DELETE RESTRICT,
  UNIQUE(forecast_id,call_line_id)
);
CREATE INDEX client_forecast_allocations_order_idx ON public.client_forecast_call_allocations(call_line_id);
CREATE TRIGGER client_forecast_allocations_immutable BEFORE UPDATE OR DELETE ON public.client_forecast_call_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE FUNCTION public.fn_client_forecast_allocation_guard_1032() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE forecast record; binding record; used numeric;
BEGIN
  SELECT * INTO STRICT forecast FROM public.client_contract_forecasts WHERE id=NEW.forecast_id FOR UPDATE;
  SELECT call.actor_user_id,cl.article_snapshot->>'root_article_id' AS root_article_id,line.quantite INTO STRICT binding
    FROM public.client_contract_call_lines cl JOIN public.client_contract_calls call ON call.id=cl.call_id
    JOIN public.commande_ligne line ON line.id=cl.commande_ligne_id WHERE cl.id=NEW.call_line_id FOR UPDATE OF line;
  IF forecast.status<>'ACTIVE' OR forecast.version<>NEW.forecast_version_before OR binding.actor_user_id<>NEW.actor_user_id
    OR binding.root_article_id IS DISTINCT FROM forecast.root_article_id::text
    OR NEW.forecast_snapshot->>'id' IS DISTINCT FROM forecast.id::text
    OR (NEW.forecast_snapshot->>'version')::integer IS DISTINCT FROM forecast.version THEN
    RAISE EXCEPTION 'Forecast allocation identity, status, actor or version changed' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(quantity),0) INTO used FROM public.client_forecast_call_allocations WHERE forecast_id=NEW.forecast_id;
  IF used+NEW.quantity>forecast.quantity THEN
    RAISE EXCEPTION 'Forecast allocation exceeds estimate remainder' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(quantity),0) INTO used FROM public.client_forecast_call_allocations WHERE call_line_id=NEW.call_line_id;
  IF used+NEW.quantity>binding.quantite THEN
    RAISE EXCEPTION 'Forecast allocations exceed firm quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_forecast_allocations_guard BEFORE INSERT ON public.client_forecast_call_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_forecast_allocation_guard_1032();
CREATE FUNCTION public.fn_client_forecast_allocation_advance_1032() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.client_contract_forecasts SET version=version+1,updated_by=NEW.actor_user_id,updated_at=now() WHERE id=NEW.forecast_id;
  RETURN NEW;
END $$;
CREATE TRIGGER client_forecast_allocations_advance AFTER INSERT ON public.client_forecast_call_allocations
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_forecast_allocation_advance_1032();
CREATE FUNCTION public.fn_client_forecast_quantity_guard_1032() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantity<(SELECT COALESCE(sum(quantity),0) FROM public.client_forecast_call_allocations WHERE forecast_id=OLD.id) THEN
    RAISE EXCEPTION 'Estimate cannot be smaller than its firm conversions' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_forecast_quantity_guard BEFORE UPDATE OF quantity ON public.client_contract_forecasts
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_forecast_quantity_guard_1032();
CREATE FUNCTION public.fn_client_forecast_firm_quantity_guard_1032() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quantite<(SELECT COALESCE(sum(a.quantity),0) FROM public.client_forecast_call_allocations a
    JOIN public.client_contract_call_lines cl ON cl.id=a.call_line_id WHERE cl.commande_ligne_id=OLD.id) THEN
    RAISE EXCEPTION 'Firm line cannot be smaller than its retained forecast allocations' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_forecast_firm_quantity_guard BEFORE UPDATE OF quantite ON public.commande_ligne
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_forecast_firm_quantity_guard_1032();
CREATE VIEW public.v_client_contract_forecast_coverage AS
  SELECT f.id AS forecast_id,COALESCE(sum(a.quantity),0)::numeric(18,3) AS converted_quantity,
    CASE WHEN f.status='ACTIVE' THEN (f.quantity-COALESCE(sum(a.quantity),0))::numeric(18,3) ELSE 0::numeric(18,3) END AS remaining_quantity
  FROM public.client_contract_forecasts f LEFT JOIN public.client_forecast_call_allocations a ON a.forecast_id=f.id GROUP BY f.id;
REVOKE ALL ON public.client_forecast_call_allocations,public.v_client_contract_forecast_coverage FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT ON public.client_forecast_call_allocations TO cerp_app;
GRANT SELECT ON public.v_client_contract_forecast_coverage TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_client_forecast_allocation_guard_1032(),public.fn_client_forecast_allocation_advance_1032(),
  public.fn_client_forecast_quantity_guard_1032(),public.fn_client_forecast_firm_quantity_guard_1032() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_client_forecast_allocation_guard_1032(),public.fn_client_forecast_allocation_advance_1032(),
  public.fn_client_forecast_quantity_guard_1032(),public.fn_client_forecast_firm_quantity_guard_1032() TO cerp_app;
COMMIT;
