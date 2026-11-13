-- Public operational notices are deliberately separate from internal planning
-- comments. Only an approved customer-facing title/message can be published.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.client_portal_operational_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  account_id uuid NULL REFERENCES public.client_portal_accounts(id) ON DELETE RESTRICT,
  delivery_address_id uuid NULL REFERENCES public.adresse_livraison(delivery_address_id) ON DELETE RESTRICT,
  notice_type text NOT NULL CHECK(notice_type IN ('FERMETURE','INVENTAIRE')),
  title text NOT NULL CHECK(char_length(btrim(title)) BETWEEN 3 AND 160),
  message text NOT NULL CHECK(char_length(btrim(message)) BETWEEN 3 AND 500),
  published_from timestamptz NOT NULL,
  published_until timestamptz NOT NULL,
  starts_on date NULL,
  ends_on date NULL,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(published_until>published_from),
  CHECK(starts_on IS NULL OR ends_on IS NULL OR ends_on>=starts_on)
);
CREATE INDEX IF NOT EXISTS client_portal_operational_notice_scope_1805_idx
  ON public.client_portal_operational_notices(client_id,published_from,published_until);

CREATE OR REPLACE FUNCTION public.fn_client_portal_operational_notice_scope_1805()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE account_client varchar;
BEGIN
  IF NEW.account_id IS NOT NULL THEN
    SELECT client_id INTO account_client FROM public.client_portal_accounts WHERE id=NEW.account_id;
    IF account_client IS NULL OR account_client<>NEW.client_id THEN RAISE EXCEPTION 'portal notice account tenant scope refused' USING ERRCODE='42501'; END IF;
  END IF;
  IF NEW.delivery_address_id IS NOT NULL THEN
    IF NEW.account_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM public.client_portal_delivery_site_bindings binding
       WHERE binding.account_id=NEW.account_id AND binding.delivery_address_id=NEW.delivery_address_id
    ) THEN RAISE EXCEPTION 'portal notice site must be an explicit account binding' USING ERRCODE='42501'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_client_portal_operational_notice_scope_1805 ON public.client_portal_operational_notices;
CREATE TRIGGER trg_client_portal_operational_notice_scope_1805 BEFORE INSERT OR UPDATE ON public.client_portal_operational_notices
FOR EACH ROW EXECUTE FUNCTION public.fn_client_portal_operational_notice_scope_1805();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT ON public.client_portal_operational_notices TO cerp_app;
 REVOKE UPDATE,DELETE,TRUNCATE ON public.client_portal_operational_notices FROM cerp_app;
END IF; END $$;
COMMIT;
