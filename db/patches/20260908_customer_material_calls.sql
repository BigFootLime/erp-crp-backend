BEGIN;

CREATE TABLE public.of_customer_material_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  need_id uuid NOT NULL REFERENCES public.of_material_needs(id) ON DELETE RESTRICT,
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  quantity numeric(14,3) NOT NULL CHECK(quantity>0),
  unit text NOT NULL CHECK(btrim(unit)<>''),
  requirements jsonb NOT NULL,
  need_date date,
  status text NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','SENT','ANNOUNCED','CANCELLED')),
  sent_reference text,
  sent_at timestamptz,
  announced_date date,
  note text NOT NULL CHECK(length(btrim(note))>=10),
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NOT NULL REFERENCES public.users(id)
);
CREATE INDEX of_customer_material_calls_need_idx ON public.of_customer_material_calls(need_id);

ALTER TABLE public.receptions_fournisseurs
  ADD COLUMN origin_type text NOT NULL DEFAULT 'SUPPLIER',
  ADD COLUMN client_proprietaire_id varchar REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  ALTER COLUMN fournisseur_id DROP NOT NULL,
  ADD CONSTRAINT reception_origin_check CHECK(
    (origin_type='SUPPLIER' AND fournisseur_id IS NOT NULL AND client_proprietaire_id IS NULL)
    OR(origin_type='CUSTOMER' AND fournisseur_id IS NULL AND client_proprietaire_id IS NOT NULL AND commande_fournisseur_id IS NULL)
  );
ALTER TABLE public.reception_fournisseur_lignes ADD COLUMN customer_material_call_id uuid REFERENCES public.of_customer_material_calls(id) ON DELETE RESTRICT;
CREATE INDEX reception_customer_material_call_idx ON public.reception_fournisseur_lignes(customer_material_call_id) WHERE customer_material_call_id IS NOT NULL;

CREATE TABLE public.of_customer_material_receipt_transfers (
  receipt_id uuid PRIMARY KEY REFERENCES public.reception_fournisseur_stock_receipts(id) ON DELETE RESTRICT,
  call_id uuid NOT NULL REFERENCES public.of_customer_material_calls(id) ON DELETE RESTRICT,
  reservation_id uuid NOT NULL UNIQUE REFERENCES public.stock_reservations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.fn_guard_customer_material_receipt_767() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reception public.receptions_fournisseurs; call public.of_customer_material_calls; need public.of_material_needs;
BEGIN
  SELECT * INTO reception FROM public.receptions_fournisseurs WHERE id=NEW.reception_id;
  IF reception.origin_type='CUSTOMER' THEN
    SELECT * INTO call FROM public.of_customer_material_calls WHERE id=NEW.customer_material_call_id;
    SELECT * INTO need FROM public.of_material_needs WHERE id=call.need_id;
    IF call.id IS NULL OR call.client_id IS DISTINCT FROM reception.client_proprietaire_id
      OR NEW.commande_fournisseur_ligne_id IS NOT NULL OR need.article_id IS DISTINCT FROM NEW.article_id
      OR call.unit IS DISTINCT FROM NEW.stock_unit OR NEW.stock_conversion_coef IS DISTINCT FROM 1::numeric
    THEN RAISE EXCEPTION 'CUSTOMER_MATERIAL_RECEIPT_ORIGIN_MISMATCH'; END IF;
  ELSIF NEW.customer_material_call_id IS NOT NULL THEN
    RAISE EXCEPTION 'CUSTOMER_MATERIAL_RECEIPT_ORIGIN_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_guard_customer_material_receipt_767 BEFORE INSERT OR UPDATE ON public.reception_fournisseur_lignes
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_customer_material_receipt_767();

ALTER TABLE public.of_customer_material_calls OWNER TO cerp_app;
ALTER TABLE public.of_customer_material_receipt_transfers OWNER TO cerp_app;
ALTER FUNCTION public.fn_guard_customer_material_receipt_767() OWNER TO cerp_app;
COMMIT;
