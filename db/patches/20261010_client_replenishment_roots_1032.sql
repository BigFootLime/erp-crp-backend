-- #1032: traceable anticipated roots and durable launch acknowledgements.
-- Applying this schema alone never creates an OF, reservation or stock movement.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE public.client_contract_replenishment_launches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL, contract_id uuid NOT NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  intent_snapshot_hash text NOT NULL CHECK(intent_snapshot_hash ~ '^[0-9a-f]{64}$'),
  result_payload jsonb NOT NULL CHECK(jsonb_typeof(result_payload)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(plan_id,contract_id) REFERENCES public.client_contract_replenishment_plans(id,contract_id) ON DELETE RESTRICT,
  UNIQUE(actor_user_id,idempotency_key), UNIQUE(id,plan_id,contract_id)
);
CREATE TABLE public.client_contract_replenishment_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  launch_id uuid NOT NULL, plan_id uuid NOT NULL, contract_id uuid NOT NULL,
  proposal_id uuid NOT NULL UNIQUE REFERENCES public.client_contract_replenishment_proposals(id) ON DELETE RESTRICT,
  root_of_id bigint NOT NULL UNIQUE REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  unit_id uuid NOT NULL REFERENCES public.units(id) ON DELETE RESTRICT,
  quantity numeric(18,3) NOT NULL CHECK(quantity>0 AND quantity<=1000000000),
  target_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(launch_id,plan_id,contract_id) REFERENCES public.client_contract_replenishment_launches(id,plan_id,contract_id) ON DELETE RESTRICT
);
CREATE INDEX client_replenishment_roots_article_idx ON public.client_contract_replenishment_roots(article_id,root_of_id);
CREATE INDEX client_replenishment_launch_history_idx ON public.client_contract_replenishment_launches(plan_id,created_at DESC,id DESC);
CREATE FUNCTION public.fn_client_replenishment_root_identity_1032() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal record; root record; owner text; actor integer;
BEGIN
  SELECT p.*,plan.status AS plan_status INTO proposal
    FROM public.client_contract_replenishment_proposals p
    JOIN public.client_contract_replenishment_plans plan ON plan.id=p.plan_id
    WHERE p.id=NEW.proposal_id FOR SHARE OF plan;
  IF NOT FOUND OR proposal.plan_status<>'CURRENT'
    OR (NEW.plan_id,NEW.contract_id,NEW.article_id,NEW.unit_id,NEW.quantity,NEW.target_date)
      IS DISTINCT FROM (proposal.plan_id,proposal.contract_id,proposal.article_id,proposal.unit_id,proposal.proposed_quantity,proposal.target_date)
    OR NEW.piece_technique_id::text IS DISTINCT FROM proposal.article_snapshot->>'piece_technique_id'
    OR NEW.piece_technique_version_id::text IS DISTINCT FROM proposal.article_snapshot->>'piece_technique_version_id' THEN
    RAISE EXCEPTION 'Replenishment root must preserve its current proposal and applicable technical identity' USING ERRCODE='23514';
  END IF;
  SELECT client_id INTO owner FROM public.client_contracts WHERE id=NEW.contract_id FOR SHARE;
  SELECT actor_user_id INTO actor FROM public.client_contract_replenishment_launches WHERE id=NEW.launch_id;
  SELECT * INTO root FROM public.ordres_fabrication WHERE id=NEW.root_of_id FOR SHARE;
  IF NOT FOUND OR root.parent_of_id IS NOT NULL OR root.root_of_id IS DISTINCT FROM root.id
    OR root.statut::text<>'BROUILLON' OR root.commande_id IS NOT NULL OR root.commande_ligne_id IS NOT NULL OR root.affaire_id IS NOT NULL
    OR root.created_by IS DISTINCT FROM actor OR COALESCE(root.quantite_bonne,0)<>0 OR COALESCE(root.quantite_rebut,0)<>0
    OR EXISTS(SELECT 1 FROM public.of_output_lots output WHERE output.of_id=root.id)
    OR (root.article_id,root.piece_technique_id,root.quantite_lancee,root.client_id::text)
      IS DISTINCT FROM (NEW.article_id,NEW.piece_technique_id,NEW.quantity,owner)
    OR COALESCE(root.technical_preparation->>'selected_version_id',root.piece_technique_version_id::text)
      IS DISTINCT FROM NEW.piece_technique_version_id::text THEN
    RAISE EXCEPTION 'Anticipated production must be an unbound draft root of the contract client' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_replenishment_root_identity BEFORE INSERT ON public.client_contract_replenishment_roots
  FOR EACH ROW EXECUTE FUNCTION public.fn_client_replenishment_root_identity_1032();
CREATE TRIGGER client_replenishment_roots_immutable BEFORE UPDATE OR DELETE ON public.client_contract_replenishment_roots
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE TRIGGER client_replenishment_launches_immutable BEFORE UPDATE OR DELETE ON public.client_contract_replenishment_launches
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
REVOKE ALL ON public.client_contract_replenishment_launches,public.client_contract_replenishment_roots FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT ON public.client_contract_replenishment_launches,public.client_contract_replenishment_roots TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_client_replenishment_root_identity_1032() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_client_replenishment_root_identity_1032() TO cerp_app;
COMMIT;
