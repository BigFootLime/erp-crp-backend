BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_requests WHERE status IN('WAITING_PLANNER','APPROVED','WITHDRAWN')
    AND (snapshot->'preview'->'urgency_fee' IS NULL OR snapshot->'preview'->'urgency_fee'='null'::jsonb)) THEN
    RAISE EXCEPTION 'Existing urgency requests need explicit price reconciliation before this migration';
  END IF;
END $$;
CREATE TABLE public.client_urgency_fee_settings (
  client_id text PRIMARY KEY REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  amount_ht numeric(12,2) NOT NULL CHECK(amount_ht>=0 AND amount_ht<1000000000),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.delivery_urgency_order_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id bigint NOT NULL UNIQUE REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  client_id text NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  request_id uuid NOT NULL REFERENCES public.delivery_urgency_requests(id) ON DELETE RESTRICT,
  withdrawal_id uuid NOT NULL UNIQUE REFERENCES public.delivery_urgency_withdrawals(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  amount_ht numeric(12,2) NOT NULL CHECK(amount_ht>=0 AND amount_ht<1000000000),
  currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  tax_rate_percent numeric(9,4) NOT NULL CHECK(tax_rate_percent BETWEEN 0 AND 100),
  settings_version integer NOT NULL CHECK(settings_version>0),
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.facture_urgency_charges (
  charge_id uuid PRIMARY KEY REFERENCES public.delivery_urgency_order_charges(id) ON DELETE RESTRICT,
  facture_id bigint NOT NULL REFERENCES public.facture(id) ON DELETE RESTRICT,
  facture_ligne_id bigint NOT NULL UNIQUE REFERENCES public.facture_ligne(id) ON DELETE RESTRICT,
  created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facture_urgency_charges_invoice_idx ON public.facture_urgency_charges(facture_id);
CREATE TRIGGER delivery_urgency_order_charges_immutable BEFORE UPDATE OR DELETE ON public.delivery_urgency_order_charges
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_stock_immutable_evidence();
CREATE FUNCTION public.fn_urgency_charge_identity_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; fee jsonb;
BEGIN
  SELECT command.id AS commande_id,command.client_id,request.snapshot INTO origin
    FROM public.delivery_urgency_requests request
    JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id
    JOIN public.commande_client command ON command.id=allocation.commande_id WHERE request.id=NEW.request_id;
  fee:=origin.snapshot->'preview'->'urgency_fee';
  IF NEW.commande_id IS DISTINCT FROM origin.commande_id OR NEW.client_id IS DISTINCT FROM origin.client_id
    OR NEW.amount_ht IS DISTINCT FROM (fee->>'amount_ht')::numeric
    OR NEW.currency IS DISTINCT FROM fee->>'currency'
    OR NEW.tax_rate_percent IS DISTINCT FROM (fee->>'tax_rate_percent')::numeric
    OR NEW.settings_version IS DISTINCT FROM (fee->>'settings_version')::integer THEN
    RAISE EXCEPTION 'Urgency charge must retain the accepted order and price' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER urgency_charge_identity BEFORE INSERT ON public.delivery_urgency_order_charges
  FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_charge_identity_1033();
CREATE FUNCTION public.fn_urgency_withdrawal_charge_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE withdrawal_uuid uuid; command_id bigint;
BEGIN
  IF TG_TABLE_NAME='delivery_urgency_withdrawals' THEN withdrawal_uuid:=NEW.id; ELSE withdrawal_uuid:=NEW.withdrawal_id; END IF;
  SELECT allocation.commande_id INTO command_id FROM public.delivery_urgency_withdrawals withdrawal
    JOIN public.delivery_urgency_requests request ON request.id=withdrawal.request_id
    JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id WHERE withdrawal.id=withdrawal_uuid;
  IF command_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.delivery_urgency_order_charges charge WHERE charge.commande_id=command_id) THEN
    RAISE EXCEPTION 'Withdrawal and one order charge must commit together' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='delivery_urgency_order_charges' THEN
    IF NOT EXISTS(SELECT 1 FROM public.delivery_urgency_withdrawals WHERE id=NEW.withdrawal_id AND request_id=NEW.request_id) THEN
      RAISE EXCEPTION 'Charge must retain its first withdrawal' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER urgency_withdrawal_charge AFTER INSERT ON public.delivery_urgency_withdrawals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_withdrawal_charge_1033();
CREATE CONSTRAINT TRIGGER urgency_charge_withdrawal AFTER INSERT ON public.delivery_urgency_order_charges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_urgency_withdrawal_charge_1033();
CREATE FUNCTION public.fn_facture_urgency_charge_1033() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE invoice record; charge record; line record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Retain urgency invoice provenance' USING ERRCODE='55000'; END IF;
  SELECT * INTO invoice FROM public.facture WHERE id=NEW.facture_id FOR UPDATE;
  IF COALESCE(invoice.document_status,invoice.statut) IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Urgency charge must be attached when the draft is created' USING ERRCODE='55000';
  END IF;
  SELECT * INTO charge FROM public.delivery_urgency_order_charges WHERE id=NEW.charge_id FOR UPDATE;
  SELECT * INTO line FROM public.facture_ligne WHERE id=NEW.facture_ligne_id;
  IF charge.client_id IS DISTINCT FROM invoice.client_id OR charge.currency IS DISTINCT FROM invoice.currency
    OR line.facture_id IS DISTINCT FROM NEW.facture_id OR line.quantite IS DISTINCT FROM 1::numeric
    OR line.prix_unitaire_ht IS DISTINCT FROM charge.amount_ht OR line.remise_ligne IS DISTINCT FROM 0::numeric
    OR line.taux_tva IS DISTINCT FROM charge.tax_rate_percent OR line.total_ht IS DISTINCT FROM charge.amount_ht
    OR line.total_ttc IS DISTINCT FROM charge.amount_ht+round(charge.amount_ht*charge.tax_rate_percent/100,2)
    OR line.tax_amount IS DISTINCT FROM round(charge.amount_ht*charge.tax_rate_percent/100,2)
    OR line.snapshot_json->>'source_type' IS DISTINCT FROM 'ORDER_CHARGE'
    OR line.snapshot_json->>'source_line_id' IS DISTINCT FROM charge.id::text
    OR line.snapshot_json->>'source_id' IS DISTINCT FROM charge.commande_id::text
    OR NOT EXISTS(SELECT 1 FROM public.facture_source_allocations source
      JOIN public.bon_livraison_ligne delivery_line ON delivery_line.id::text=source.source_line_id AND source.source_type='DELIVERY_LINE'
      JOIN public.bon_livraison delivery ON delivery.id=delivery_line.bon_livraison_id
      LEFT JOIN public.commande_ligne order_line ON order_line.id=delivery_line.commande_ligne_id
      WHERE source.facture_id=NEW.facture_id AND COALESCE(order_line.commande_id,delivery.commande_id)=charge.commande_id) THEN
    RAISE EXCEPTION 'Invoice must retain the single accepted urgency charge' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facture_urgency_charge BEFORE INSERT OR UPDATE OR DELETE ON public.facture_urgency_charges
  FOR EACH ROW EXECUTE FUNCTION public.fn_facture_urgency_charge_1033();
CREATE FUNCTION public.fn_protect_facture_urgency_line_1033() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.facture_urgency_charges WHERE facture_ligne_id=OLD.id) THEN
    RAISE EXCEPTION 'Accepted urgency line is immutable; use the credit note workflow' USING ERRCODE='55000';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER protect_facture_urgency_line BEFORE UPDATE OR DELETE ON public.facture_ligne
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_facture_urgency_line_1033();
REVOKE ALL ON public.client_urgency_fee_settings,public.delivery_urgency_order_charges,public.facture_urgency_charges FROM PUBLIC,cerp_app;
GRANT SELECT,INSERT,UPDATE ON public.client_urgency_fee_settings TO cerp_app;
GRANT SELECT,INSERT ON public.delivery_urgency_order_charges TO cerp_app;
-- PostgreSQL row locks require UPDATE on at least one column. The immutable
-- trigger still rejects every actual update; no price column is writable.
GRANT UPDATE(id) ON public.delivery_urgency_order_charges TO cerp_app;
GRANT SELECT,INSERT ON public.facture_urgency_charges TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_urgency_charge_identity_1033(),public.fn_urgency_withdrawal_charge_1033(),public.fn_facture_urgency_charge_1033() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_urgency_charge_identity_1033(),public.fn_urgency_withdrawal_charge_1033(),public.fn_facture_urgency_charge_1033() TO cerp_app;
REVOKE ALL ON FUNCTION public.fn_protect_facture_urgency_line_1033() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_protect_facture_urgency_line_1033() TO cerp_app;
COMMIT;
