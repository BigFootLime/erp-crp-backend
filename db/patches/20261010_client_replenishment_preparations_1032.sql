-- #1032: immutable preparation evidence; not available stock and no OF generation.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.client_contract_replenishment_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
  contract_version integer NOT NULL CHECK(contract_version>0),
  status text NOT NULL DEFAULT 'CURRENT' CHECK(status IN('CURRENT','SUPERSEDED')),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  coverage_snapshot_hash text NOT NULL CHECK(coverage_snapshot_hash ~ '^[0-9a-f]{64}$'),
  start_month date NOT NULL CHECK(extract(day FROM start_month)=1 AND start_month BETWEEN '1900-01-01' AND '2199-12-01'),
  months integer NOT NULL CHECK(months BETWEEN 1 AND 36),
  as_of_date date NOT NULL,
  coverage_snapshot jsonb NOT NULL CHECK(jsonb_typeof(coverage_snapshot)='object'
    AND coverage_snapshot ?& ARRAY['readonly','contract_id','snapshot_hash'] AND coverage_snapshot->>'readonly'='true'
    AND coverage_snapshot->>'contract_id'=contract_id::text AND coverage_snapshot->>'snapshot_hash'=coverage_snapshot_hash),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,contract_id)
);
CREATE UNIQUE INDEX client_replenishment_current_plan_idx ON public.client_contract_replenishment_plans(contract_id) WHERE status='CURRENT';
CREATE TABLE public.client_contract_replenishment_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL, contract_id uuid NOT NULL, contract_line_id uuid NOT NULL,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  root_article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  article_snapshot jsonb NOT NULL CHECK(jsonb_typeof(article_snapshot)='object'),
  month date NOT NULL CHECK(extract(day FROM month)=1 AND month BETWEEN '1900-01-01' AND '2199-12-01'),
  target_date date NOT NULL CHECK(target_date=month-1), target_overdue boolean NOT NULL,
  lot_quantity numeric(18,3) NOT NULL CHECK(lot_quantity>0 AND lot_quantity<=1000000000),
  lot_count bigint NOT NULL CHECK(lot_count>0),
  proposed_quantity numeric(18,3) NOT NULL CHECK(proposed_quantity>0 AND proposed_quantity<=1000000000
    AND proposed_quantity=lot_quantity*lot_count),
  surplus_quantity numeric(18,3) NOT NULL CHECK(surplus_quantity>=0 AND surplus_quantity<lot_quantity),
  FOREIGN KEY(plan_id,contract_id) REFERENCES public.client_contract_replenishment_plans(id,contract_id) ON DELETE RESTRICT,
  FOREIGN KEY(contract_line_id,contract_id) REFERENCES public.client_contract_lines(id,contract_id) ON DELETE RESTRICT,
  UNIQUE(plan_id,contract_line_id,month)
);
CREATE TABLE public.client_contract_replenishment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plan_id uuid NOT NULL, contract_id uuid NOT NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  previous_plan_id uuid, result_payload jsonb NOT NULL CHECK(jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(plan_id,contract_id) REFERENCES public.client_contract_replenishment_plans(id,contract_id) ON DELETE RESTRICT,
  FOREIGN KEY(previous_plan_id,contract_id) REFERENCES public.client_contract_replenishment_plans(id,contract_id) ON DELETE RESTRICT,
  UNIQUE(actor_user_id,idempotency_key)
);
CREATE INDEX client_replenishment_history_idx ON public.client_contract_replenishment_events(plan_id,created_at DESC,id DESC);
CREATE TRIGGER client_replenishment_proposals_immutable BEFORE UPDATE OR DELETE ON public.client_contract_replenishment_proposals
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER client_replenishment_events_immutable BEFORE UPDATE OR DELETE ON public.client_contract_replenishment_events
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE FUNCTION public.fn_client_replenishment_plan_identity_1032() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.id,NEW.contract_id,NEW.contract_version,NEW.fingerprint,NEW.coverage_snapshot_hash,
    NEW.start_month,NEW.months,NEW.as_of_date,NEW.coverage_snapshot,NEW.created_by,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.contract_id,OLD.contract_version,OLD.fingerprint,OLD.coverage_snapshot_hash,
    OLD.start_month,OLD.months,OLD.as_of_date,OLD.coverage_snapshot,OLD.created_by,OLD.created_at)
    OR OLD.status<>'CURRENT' OR NEW.status<>'SUPERSEDED' THEN
    RAISE EXCEPTION 'Only an unused current preparation may be superseded; retain its immutable snapshot' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_replenishment_plan_identity BEFORE UPDATE OR DELETE ON public.client_contract_replenishment_plans
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_replenishment_plan_identity_1032();
CREATE FUNCTION public.fn_client_replenishment_proposal_identity_1032() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE definition record; preparation record;
BEGIN
  SELECT root_article_id,unit_id INTO definition FROM public.client_contract_lines
    WHERE id=NEW.contract_line_id AND contract_id=NEW.contract_id FOR SHARE;
  IF NOT FOUND OR (NEW.root_article_id,NEW.unit_id) IS DISTINCT FROM (definition.root_article_id,definition.unit_id)
    OR NEW.article_snapshot->>'article_id' IS DISTINCT FROM NEW.article_id::text
    OR NEW.article_snapshot->>'root_article_id' IS DISTINCT FROM NEW.root_article_id::text
    OR NEW.article_snapshot->>'unit_id' IS DISTINCT FROM NEW.unit_id::text THEN
    RAISE EXCEPTION 'Preparation article family or unit mismatch' USING ERRCODE='23514';
  END IF;
  SELECT start_month,months,as_of_date,status INTO preparation FROM public.client_contract_replenishment_plans
    WHERE id=NEW.plan_id AND contract_id=NEW.contract_id FOR SHARE;
  IF NOT FOUND OR preparation.status<>'CURRENT' OR NEW.month<preparation.start_month
    OR NEW.month>=(preparation.start_month+make_interval(months=>preparation.months))::date
    OR NEW.target_overdue IS DISTINCT FROM (NEW.target_date<preparation.as_of_date) THEN
    RAISE EXCEPTION 'Preparation horizon or original target mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_replenishment_proposal_identity BEFORE INSERT ON public.client_contract_replenishment_proposals
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_replenishment_proposal_identity_1032();
CREATE FUNCTION public.fn_client_replenishment_line_guard_1032() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.contract_id,NEW.root_article_id,NEW.unit_id) IS DISTINCT FROM
    (OLD.id,OLD.contract_id,OLD.root_article_id,OLD.unit_id)
    AND EXISTS(SELECT 1 FROM public.client_contract_replenishment_proposals WHERE contract_line_id=OLD.id) THEN
    RAISE EXCEPTION 'Keep the identity and unit of preparation-backed contract lines' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_replenishment_line_guard BEFORE UPDATE ON public.client_contract_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_replenishment_line_guard_1032();
REVOKE ALL ON public.client_contract_replenishment_plans,public.client_contract_replenishment_proposals,public.client_contract_replenishment_events FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.client_contract_replenishment_plans TO cerp_app;
GRANT SELECT,INSERT ON public.client_contract_replenishment_proposals,public.client_contract_replenishment_events TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_client_replenishment_plan_identity_1032(),public.fn_client_replenishment_proposal_identity_1032(),public.fn_client_replenishment_line_guard_1032() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_client_replenishment_plan_identity_1032(),public.fn_client_replenishment_proposal_identity_1032(),public.fn_client_replenishment_line_guard_1032() TO cerp_app;
COMMIT;
