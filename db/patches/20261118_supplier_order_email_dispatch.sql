BEGIN;

CREATE TABLE IF NOT EXISTS public.supplier_order_email_dispatch (
  order_id uuid PRIMARY KEY REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  intent_hash text NOT NULL CHECK (length(intent_hash) = 64),
  actor_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  CHECK ((provider_id IS NULL) = (delivered_at IS NULL))
);

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.supplier_order_email_dispatch TO cerp_app;
  END IF;
END;
$grant$;

COMMIT;
