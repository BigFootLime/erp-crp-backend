BEGIN;

CREATE TABLE IF NOT EXISTS public.client_portal_delivery_site_bindings (
  account_id uuid NOT NULL REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  delivery_address_id uuid NOT NULL REFERENCES public.adresse_livraison(delivery_address_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, delivery_address_id)
);

CREATE TABLE IF NOT EXISTS public.client_portal_delivery_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id uuid NOT NULL REFERENCES public.bon_livraison(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  delivered_at timestamptz NOT NULL,
  received_by_name text NULL,
  note text NULL,
  request_id text NULL,
  request_hash text NOT NULL DEFAULT repeat('0',64) CHECK(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portal_delivery_receipt_key_uq UNIQUE(account_id,idempotency_key),
  CONSTRAINT client_portal_delivery_receipt_name_ck CHECK(received_by_name IS NULL OR char_length(btrim(received_by_name)) BETWEEN 1 AND 200),
  CONSTRAINT client_portal_delivery_receipt_note_ck CHECK(note IS NULL OR char_length(note)<=2000)
);
ALTER TABLE public.client_portal_delivery_receipts ADD COLUMN IF NOT EXISTS request_hash text NOT NULL DEFAULT repeat('0',64);
CREATE TABLE IF NOT EXISTS public.client_portal_delivery_receipt_lines (
  receipt_id uuid NOT NULL REFERENCES public.client_portal_delivery_receipts(id) ON DELETE RESTRICT,
  bon_livraison_ligne_id uuid NOT NULL REFERENCES public.bon_livraison_ligne(id) ON DELETE RESTRICT,
  quantity_received numeric(18,3) NOT NULL CHECK(quantity_received>0),
  PRIMARY KEY(receipt_id,bon_livraison_ligne_id)
);

CREATE OR REPLACE FUNCTION public.fn_client_portal_delivery_receipt_guard_1802() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_client varchar(3); delivery_client varchar(3); delivery_site uuid;
BEGIN
  SELECT client_id INTO account_client FROM public.client_portal_accounts WHERE id=NEW.account_id AND status='ACTIVE';
  SELECT client_id,adresse_livraison_id INTO delivery_client,delivery_site FROM public.bon_livraison WHERE id=NEW.bon_livraison_id AND statut IN ('SHIPPED','DELIVERED');
  IF account_client IS NULL OR delivery_client IS NULL OR account_client<>delivery_client OR delivery_site IS NULL
     OR NOT EXISTS(SELECT 1 FROM public.client_portal_delivery_site_bindings WHERE account_id=NEW.account_id AND delivery_address_id=delivery_site) THEN
    RAISE EXCEPTION 'portal delivery receipt tenant/site scope refused' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_client_portal_delivery_receipt_guard_1802 ON public.client_portal_delivery_receipts;
CREATE TRIGGER trg_client_portal_delivery_receipt_guard_1802 BEFORE INSERT ON public.client_portal_delivery_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_delivery_receipt_guard_1802();

CREATE OR REPLACE FUNCTION public.fn_client_portal_delivery_evidence_immutable_1802() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'portal delivery receipt is immutable' USING ERRCODE='55000'; END $$;
DROP TRIGGER IF EXISTS trg_client_portal_delivery_receipts_immutable_1802 ON public.client_portal_delivery_receipts;
CREATE TRIGGER trg_client_portal_delivery_receipts_immutable_1802 BEFORE UPDATE OR DELETE ON public.client_portal_delivery_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_delivery_evidence_immutable_1802();
DROP TRIGGER IF EXISTS trg_client_portal_delivery_receipt_lines_immutable_1802 ON public.client_portal_delivery_receipt_lines;
CREATE TRIGGER trg_client_portal_delivery_receipt_lines_immutable_1802 BEFORE UPDATE OR DELETE ON public.client_portal_delivery_receipt_lines FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_delivery_evidence_immutable_1802();
CREATE INDEX IF NOT EXISTS client_portal_delivery_receipts_bl_1802_idx ON public.client_portal_delivery_receipts(bon_livraison_id,created_at DESC);

DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT ON public.client_portal_delivery_site_bindings,public.client_portal_delivery_receipts,public.client_portal_delivery_receipt_lines TO cerp_app;
END IF; END $$;
COMMIT;
