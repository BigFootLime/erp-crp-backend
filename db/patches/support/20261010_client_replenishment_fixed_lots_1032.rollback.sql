-- Only unused per-lot installation can be rolled back. Legacy evidence is preserved.
BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE public.client_contract_replenishment_roots IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.client_contract_replenishment_roots WHERE lot_index IS NOT NULL) THEN
    RAISE EXCEPTION 'Per-lot launch evidence exists; rollback forbidden';
  END IF;
END $$;
DROP TRIGGER client_replenishment_fixed_lots ON public.client_contract_replenishment_roots;
DROP FUNCTION public.fn_client_replenishment_fixed_lots_1032();
DROP INDEX public.client_replenishment_roots_proposal_lot_key;
DROP INDEX public.client_replenishment_roots_legacy_proposal_key;
ALTER TABLE public.client_contract_replenishment_roots DROP COLUMN lot_index;
ALTER TABLE public.client_contract_replenishment_roots ADD CONSTRAINT client_contract_replenishment_roots_proposal_id_key UNIQUE(proposal_id);
CREATE OR REPLACE FUNCTION public.fn_client_replenishment_root_identity_1032() RETURNS trigger LANGUAGE plpgsql AS $$
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
COMMIT;
