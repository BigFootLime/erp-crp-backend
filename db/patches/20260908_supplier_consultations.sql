-- #767 / L4. Consultations annotate a canonical purchase draft; they never
-- create another purchase, material allocation or supplier communication.
BEGIN;
CREATE TABLE IF NOT EXISTS public.supplier_consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commande_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  round_no integer NOT NULL CHECK(round_no>0),
  status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','SELECTED','CLOSED')),
  source_revision text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  notes text NOT NULL DEFAULT '',
  selected_offer_id uuid,
  selection_reason text,
  decided_by integer REFERENCES public.users(id),
  decided_at timestamptz,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(commande_id,round_no),
  CHECK((status='SELECTED')=(selected_offer_id IS NOT NULL AND selection_reason IS NOT NULL AND length(trim(selection_reason))>=3 AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS supplier_consultation_open_idx ON public.supplier_consultations(commande_id) WHERE status='OPEN';
CREATE TABLE IF NOT EXISTS public.supplier_consultation_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES public.supplier_consultations(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id),
  request_text text NOT NULL,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(consultation_id,supplier_id)
);
CREATE TABLE IF NOT EXISTS public.supplier_consultation_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES public.supplier_consultation_invitations(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK(revision>0),
  response jsonb NOT NULL CHECK(jsonb_typeof(response)='object'),
  correction_reason text,
  created_by integer NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(invitation_id,revision),
  CHECK(revision=1 OR (correction_reason IS NOT NULL AND length(trim(correction_reason))>=3))
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.supplier_consultations'::regclass AND conname='supplier_consultation_selected_offer_fk') THEN
    ALTER TABLE public.supplier_consultations ADD CONSTRAINT supplier_consultation_selected_offer_fk FOREIGN KEY(selected_offer_id) REFERENCES public.supplier_consultation_offers(id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.supplier_consultation_commands (
  actor_id integer NOT NULL REFERENCES public.users(id),
  command_key text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,command_key)
);
ALTER TABLE public.supplier_consultations OWNER TO cerp_app;
ALTER TABLE public.supplier_consultation_invitations OWNER TO cerp_app;
ALTER TABLE public.supplier_consultation_offers OWNER TO cerp_app;
ALTER TABLE public.supplier_consultation_commands OWNER TO cerp_app;
COMMIT;
