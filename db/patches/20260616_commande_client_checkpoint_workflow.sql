-- Commande Client checkpoint workflow engine.
-- Adds reusable checkpoint persistence without replacing existing commande_historique traceability.

CREATE TABLE IF NOT EXISTS public.commande_client_workflow_checkpoint (
  id bigserial PRIMARY KEY,
  commande_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE CASCADE,
  checkpoint_code text NOT NULL,
  label text NOT NULL,
  sort_order integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  responsible_role text NOT NULL,
  assigned_user_id integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  due_at timestamptz NULL,
  completed_at timestamptz NULL,
  completed_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  blocked_reason text NULL,
  notes text NULL,
  action_key text NULL,
  action_label text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commande_client_workflow_checkpoint_status_chk
    CHECK (status IN ('pending', 'active', 'blocked', 'done', 'skipped')),
  CONSTRAINT commande_client_workflow_checkpoint_code_uniq
    UNIQUE (commande_id, checkpoint_code)
);

CREATE INDEX IF NOT EXISTS idx_commande_client_workflow_checkpoint_commande
  ON public.commande_client_workflow_checkpoint (commande_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_commande_client_workflow_checkpoint_role_status
  ON public.commande_client_workflow_checkpoint (responsible_role, status, due_at);

CREATE INDEX IF NOT EXISTS idx_commande_client_workflow_checkpoint_assigned
  ON public.commande_client_workflow_checkpoint (assigned_user_id, status, due_at)
  WHERE assigned_user_id IS NOT NULL;

COMMENT ON TABLE public.commande_client_workflow_checkpoint IS
  'Reusable checkpoint engine for Commande Client operational workflow.';

COMMENT ON COLUMN public.commande_client_workflow_checkpoint.status IS
  'Checkpoint status: pending, active, blocked, done, skipped.';
