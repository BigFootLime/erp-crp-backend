BEGIN;
-- An ADV preparation is a durable commercial intent, not a planning decision.
CREATE TABLE IF NOT EXISTS public.demand_pilot_firm_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_key uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  external_site text NOT NULL,
  external_order_key text NOT NULL,
  commande_id bigint NOT NULL UNIQUE REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(client_id, external_site, external_order_key)
);
CREATE TABLE IF NOT EXISTS public.demand_pilot_firm_draft_lines (
  revision_id uuid PRIMARY KEY REFERENCES public.demand_pilot_revisions(id) ON DELETE RESTRICT,
  draft_id uuid NOT NULL REFERENCES public.demand_pilot_firm_drafts(id) ON DELETE RESTRICT,
  commande_ligne_id bigint NOT NULL REFERENCES public.commande_ligne(id) ON DELETE RESTRICT,
  source_revision_no integer NOT NULL CHECK(source_revision_no > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Several source revisions can evidence the same canonical draft line.
  -- The source revision itself remains immutable and singly mapped.
  UNIQUE(draft_id, commande_ligne_id, revision_id)
);
-- A confirmed promise belongs to one external schedule identity, not merely to
-- its first imported revision.  This permits later versions of that schedule.
ALTER TABLE public.demand_pilot_firm_bindings DROP CONSTRAINT IF EXISTS demand_pilot_firm_bindings_promise_root_id_key;
CREATE TABLE IF NOT EXISTS public.demand_pilot_firm_binding_scopes (
 client_id varchar NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
 external_site text NOT NULL, external_order_key text NOT NULL, external_line_key text NOT NULL, external_schedule_key text NOT NULL,
 promise_root_id uuid NOT NULL UNIQUE REFERENCES public.delivery_promise_roots(id) ON DELETE RESTRICT,
 article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
 contract_id uuid REFERENCES public.client_contracts(id) ON DELETE RESTRICT,
 contract_line_id uuid,
 created_by_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(client_id,external_site,external_order_key,external_line_key,external_schedule_key),
 FOREIGN KEY(contract_line_id,contract_id) REFERENCES public.client_contract_lines(id,contract_id) ON DELETE RESTRICT
);
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
 GRANT SELECT,INSERT ON public.demand_pilot_firm_drafts,public.demand_pilot_firm_draft_lines,public.demand_pilot_firm_binding_scopes TO cerp_app;
 REVOKE UPDATE,DELETE,TRUNCATE ON public.demand_pilot_firm_drafts,public.demand_pilot_firm_draft_lines,public.demand_pilot_firm_binding_scopes FROM cerp_app;
END IF; END $$;
COMMIT;
