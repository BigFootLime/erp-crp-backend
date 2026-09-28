-- CERP demo only. Apply manually to cerp_demo after a backup; the guard makes
-- accidental execution on a shared database fail closed.
BEGIN;
DO $$
BEGIN
  IF current_database() <> 'cerp_demo' THEN
    RAISE EXCEPTION 'This patch is restricted to cerp_demo (current: %)', current_database();
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.demo_presentation_scenarios (
  id uuid PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES public.users(id),
  start_key varchar(200) NOT NULL,
  status text NOT NULL CHECK (status IN ('INITIALIZING','QUOTE_DRAFT','COMMANDE_CREATED','AFFAIRE_CREATED','PRODUCTION_READY','PLANNED','RUNNING','PAUSED','QUANTITY_DECLARED','COMPLETED')),
  fixture_code text NOT NULL DEFAULT 'E2E-DEMO-01',
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id),
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id),
  machine_id uuid NOT NULL REFERENCES public.machines(id),
  client_id text NULL REFERENCES public.clients(client_id),
  devis_id bigint NULL REFERENCES public.devis(id),
  commande_id bigint NULL REFERENCES public.commande_client(id),
  affaire_id bigint NULL REFERENCES public.affaire(id),
  of_id bigint NULL REFERENCES public.ordres_fabrication(id),
  operation_id uuid NULL REFERENCES public.of_operations(id),
  execution_id uuid NULL REFERENCES public.production_pointages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS demo_presentation_one_active_per_user
  ON public.demo_presentation_scenarios(user_id)
  WHERE status <> 'COMPLETED';

CREATE UNIQUE INDEX IF NOT EXISTS demo_presentation_start_key_per_user
  ON public.demo_presentation_scenarios(user_id, start_key);

CREATE INDEX IF NOT EXISTS demo_presentation_scenarios_user_created_idx
  ON public.demo_presentation_scenarios(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.demo_presentation_action_receipts (
  scenario_id uuid NOT NULL REFERENCES public.demo_presentation_scenarios(id) ON DELETE CASCADE,
  action text NOT NULL,
  request_key varchar(200) NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_id, action, request_key)
);

COMMIT;
