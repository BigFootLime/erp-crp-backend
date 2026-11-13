-- #1032: one immutable anticipated root per fixed lot; legacy evidence stays untouched.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.client_contract_replenishment_roots ADD COLUMN lot_index integer CHECK(lot_index>0);
ALTER TABLE public.client_contract_replenishment_roots DROP CONSTRAINT client_contract_replenishment_roots_proposal_id_key;
CREATE UNIQUE INDEX client_replenishment_roots_proposal_lot_key ON public.client_contract_replenishment_roots(proposal_id,lot_index) WHERE lot_index IS NOT NULL;
CREATE UNIQUE INDEX client_replenishment_roots_legacy_proposal_key ON public.client_contract_replenishment_roots(proposal_id) WHERE lot_index IS NULL;
CREATE OR REPLACE FUNCTION public.fn_client_replenishment_root_identity_1032() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal record; root record; owner text; actor integer;
BEGIN
  SELECT p.*,plan.status AS plan_status INTO proposal
    FROM public.client_contract_replenishment_proposals p
    JOIN public.client_contract_replenishment_plans plan ON plan.id=p.plan_id
    WHERE p.id=NEW.proposal_id FOR SHARE OF plan;
  IF NOT FOUND OR proposal.plan_status<>'CURRENT'
    OR NEW.lot_index IS NULL OR NEW.lot_index<1 OR NEW.lot_index>proposal.lot_count
    OR proposal.proposed_quantity<>proposal.lot_quantity*proposal.lot_count
    OR EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots r WHERE r.proposal_id=NEW.proposal_id AND r.lot_index IS NULL)
    OR (NEW.plan_id,NEW.contract_id,NEW.article_id,NEW.unit_id,NEW.quantity,NEW.target_date)
      IS DISTINCT FROM (proposal.plan_id,proposal.contract_id,proposal.article_id,proposal.unit_id,proposal.lot_quantity,proposal.target_date)
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
CREATE FUNCTION public.fn_client_replenishment_fixed_lots_1032() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proposal record; evidence record;
BEGIN
  SELECT * INTO proposal FROM public.client_contract_replenishment_proposals WHERE id=NEW.proposal_id;
  SELECT count(*) AS n,sum(quantity) AS quantity,min(lot_index) AS first,max(lot_index) AS last,
    count(DISTINCT launch_id) AS launches,bool_and(lot_index IS NOT NULL) AS indexed
    INTO evidence FROM public.client_contract_replenishment_roots WHERE proposal_id=NEW.proposal_id;
  IF NOT FOUND OR evidence.n<>proposal.lot_count OR evidence.quantity<>proposal.proposed_quantity
    OR evidence.first<>1 OR evidence.last<>proposal.lot_count OR evidence.launches<>1 OR NOT evidence.indexed THEN
    RAISE EXCEPTION 'Every fixed lot must be generated atomically in the same launch' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER client_replenishment_fixed_lots AFTER INSERT ON public.client_contract_replenishment_roots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_client_replenishment_fixed_lots_1032();
REVOKE ALL ON FUNCTION public.fn_client_replenishment_fixed_lots_1032() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_client_replenishment_fixed_lots_1032() TO cerp_app;
COMMIT;
