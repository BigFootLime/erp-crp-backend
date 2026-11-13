-- #1032: customer estimates; no firm order, stock movement or OF is created here.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.client_contract_forecasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL,
  contract_line_id uuid NOT NULL,
  root_article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  article_snapshot jsonb NOT NULL CHECK(jsonb_typeof(article_snapshot)='object'),
  month date NOT NULL CHECK(extract(day FROM month)=1 AND month BETWEEN '1900-01-01' AND '2199-12-01'),
  quantity numeric(18,3) NOT NULL CHECK(quantity>=0 AND quantity<=1000000000),
  delivery_due date NOT NULL CHECK(delivery_due>=month AND delivery_due<(month+interval '1 month')::date),
  estimate_date date NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','CANCELLED')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(contract_line_id,contract_id) REFERENCES public.client_contract_lines(id,contract_id) ON DELETE RESTRICT,
  UNIQUE(contract_line_id,month), UNIQUE(id,contract_id)
);
CREATE INDEX client_contract_forecasts_period_idx ON public.client_contract_forecasts(contract_id,month,id);
CREATE TABLE public.client_contract_forecast_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_id uuid NOT NULL,
  contract_id uuid NOT NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  action text NOT NULL CHECK(action IN('SAVE','CANCEL')),
  reason text,
  contract_version integer NOT NULL CHECK(contract_version>0),
  previous_snapshot jsonb,
  result_payload jsonb NOT NULL CHECK(jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(forecast_id,contract_id) REFERENCES public.client_contract_forecasts(id,contract_id) ON DELETE RESTRICT,
  UNIQUE(actor_user_id,idempotency_key)
);
CREATE INDEX client_contract_forecast_events_history_idx ON public.client_contract_forecast_events(forecast_id,created_at DESC,id DESC);
CREATE TRIGGER client_contract_forecast_events_immutable BEFORE UPDATE OR DELETE ON public.client_contract_forecast_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE FUNCTION public.fn_client_contract_forecast_identity_1032() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition record;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.contract_id,NEW.contract_line_id,NEW.root_article_id,NEW.unit_id,
    NEW.month,NEW.article_snapshot,NEW.created_by,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.contract_id,OLD.contract_line_id,OLD.root_article_id,OLD.unit_id,
    OLD.month,OLD.article_snapshot,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Forecast identity and initial article snapshot are immutable' USING ERRCODE='55000';
  END IF;
  SELECT root_article_id,unit_id INTO definition FROM public.client_contract_lines
    WHERE id=NEW.contract_line_id AND contract_id=NEW.contract_id FOR SHARE;
  IF NOT FOUND OR (NEW.root_article_id,NEW.unit_id) IS DISTINCT FROM (definition.root_article_id,definition.unit_id) THEN
    RAISE EXCEPTION 'Forecast contract family or unit mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Forecast version must advance once' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_contract_forecast_identity BEFORE INSERT OR UPDATE ON public.client_contract_forecasts
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_contract_forecast_identity_1032();
CREATE FUNCTION public.fn_client_contract_forecast_line_guard_1032() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.contract_id,NEW.root_article_id,NEW.unit_id) IS DISTINCT FROM
    (OLD.id,OLD.contract_id,OLD.root_article_id,OLD.unit_id)
    AND EXISTS(SELECT 1 FROM public.client_contract_forecasts WHERE contract_line_id=OLD.id) THEN
    RAISE EXCEPTION 'Keep the identity and unit of forecast-backed contract lines' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_contract_forecast_line_guard BEFORE UPDATE ON public.client_contract_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_contract_forecast_line_guard_1032();
REVOKE ALL ON public.client_contract_forecasts,public.client_contract_forecast_events FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.client_contract_forecasts TO cerp_app;
GRANT SELECT,INSERT ON public.client_contract_forecast_events TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_client_contract_forecast_identity_1032(),public.fn_client_contract_forecast_line_guard_1032() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_client_contract_forecast_identity_1032(),public.fn_client_contract_forecast_line_guard_1032() TO cerp_app;
COMMIT;
