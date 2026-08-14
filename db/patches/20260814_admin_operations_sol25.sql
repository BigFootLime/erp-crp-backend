-- SOL-25 — Administration, revue d'accès et notifications actionnables.
-- Migration additive et idempotente. Aucun compte ni droit n'est modifié.
-- Preflight : support/20260814_admin_operations_sol25.preflight.sql
-- Verify    : support/20260814_admin_operations_sol25.verify.sql
-- Rollback  : support/20260814_admin_operations_sol25.rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS public.app_access_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  inactivity_days integer NOT NULL CHECK (inactivity_days BETWEEN 30 AND 730),
  login_failure_window_days integer NOT NULL CHECK (login_failure_window_days BETWEEN 1 AND 90),
  failed_login_threshold integer NOT NULL CHECK (failed_login_threshold BETWEEN 1 AND 100),
  due_at timestamptz NOT NULL,
  created_by integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by integer NULL,
  closed_at timestamptz NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash char(64) NOT NULL,
  CONSTRAINT app_access_reviews_period_ck CHECK (period_start <= period_end),
  CONSTRAINT app_access_reviews_due_ck CHECK (due_at >= created_at),
  CONSTRAINT app_access_reviews_closed_ck CHECK (
    (status = 'OPEN' AND closed_at IS NULL AND closed_by IS NULL)
    OR (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
  ),
  CONSTRAINT app_access_reviews_idempotency_uq UNIQUE (created_by, idempotency_key)
);

CREATE INDEX IF NOT EXISTS app_access_reviews_status_due_idx
  ON public.app_access_reviews (status, due_at, created_at DESC);

-- The service also serializes creation, but this invariant prevents two open
-- reviews if another writer bypasses the API or two deployments overlap.
CREATE UNIQUE INDEX IF NOT EXISTS app_access_reviews_single_open_uq
  ON public.app_access_reviews ((status))
  WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS public.app_access_review_items (
  review_id uuid NOT NULL REFERENCES public.app_access_reviews(id) ON DELETE RESTRICT,
  user_id integer NOT NULL,
  snapshot_username text NOT NULL,
  snapshot_status text NULL,
  snapshot_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_superadmin boolean NOT NULL DEFAULT false,
  last_activity_at timestamptz NULL,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  last_failed_login_at timestamptz NULL,
  exceptional_module_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  risk_level text NOT NULL CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
  decision text NULL CHECK (decision IN ('CONFIRMED', 'CHANGE_REQUIRED', 'EXCEPTION_ACCEPTED')),
  decision_rationale text NULL,
  decided_by integer NULL,
  decided_at timestamptz NULL,
  decision_idempotency_key text NULL,
  decision_request_hash char(64) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_access_review_items_pkey PRIMARY KEY (review_id, user_id),
  CONSTRAINT app_access_review_items_roles_array_ck CHECK (jsonb_typeof(snapshot_roles) = 'array'),
  CONSTRAINT app_access_review_items_modules_array_ck CHECK (jsonb_typeof(exceptional_module_keys) = 'array'),
  CONSTRAINT app_access_review_items_reasons_array_ck CHECK (jsonb_typeof(risk_reasons) = 'array'),
  CONSTRAINT app_access_review_items_decision_ck CHECK (
    (decision IS NULL AND decision_rationale IS NULL AND decided_by IS NULL AND decided_at IS NULL
      AND decision_idempotency_key IS NULL AND decision_request_hash IS NULL)
    OR
    (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL
      AND decision_idempotency_key IS NOT NULL AND decision_request_hash IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS app_access_review_items_pending_idx
  ON public.app_access_review_items (review_id, risk_level, user_id)
  WHERE decision IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_access_review_items_decision_idempotency_uq
  ON public.app_access_review_items (review_id, decision_idempotency_key)
  WHERE decision_idempotency_key IS NOT NULL;

ALTER TABLE public.app_notifications
  ADD COLUMN IF NOT EXISTS entity_type text NULL,
  ADD COLUMN IF NOT EXISTS entity_id text NULL,
  ADD COLUMN IF NOT EXISTS action_key text NULL,
  ADD COLUMN IF NOT EXISTS module_key text NULL,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS muted_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS state_updated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS state_updated_by integer NULL;

-- Les seuls producteurs historiques sont liés aux commandes clients. Le backfill
-- ne lit que des identifiants métier déjà présents dans le payload et n'écrase
-- jamais une classification explicite.
UPDATE public.app_notifications
SET entity_type = COALESCE(entity_type, 'COMMANDE_CLIENT'),
    entity_id = COALESCE(entity_id, payload->>'commande_id'),
    module_key = COALESCE(module_key, 'commandes-clients'),
    action_key = COALESCE(action_key, 'OPEN_COMMANDE')
WHERE payload ? 'commande_id'
  AND NULLIF(payload->>'commande_id', '') IS NOT NULL
  AND (entity_type IS NULL OR entity_id IS NULL OR module_key IS NULL OR action_key IS NULL);

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.app_notifications'::regclass
      AND conname = 'app_notifications_action_url_internal_ck'
  ) THEN
    ALTER TABLE public.app_notifications
      ADD CONSTRAINT app_notifications_action_url_internal_ck
      CHECK (
        action_url IS NULL
        OR (
          action_url LIKE '/%'
          AND action_url NOT LIKE '//%'
          AND position(E'\\' in action_url) = 0
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.app_notifications'::regclass
      AND conname = 'app_notifications_escalation_level_ck'
  ) THEN
    ALTER TABLE public.app_notifications
      ADD CONSTRAINT app_notifications_escalation_level_ck
      CHECK (escalation_level BETWEEN 0 AND 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.app_notifications'::regclass
      AND conname = 'app_notifications_entity_pair_ck'
  ) THEN
    ALTER TABLE public.app_notifications
      ADD CONSTRAINT app_notifications_entity_pair_ck
      CHECK ((entity_type IS NULL) = (entity_id IS NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.app_notifications'::regclass
      AND conname = 'app_notifications_expiry_ck'
  ) THEN
    ALTER TABLE public.app_notifications
      ADD CONSTRAINT app_notifications_expiry_ck
      CHECK (expires_at IS NULL OR expires_at > created_at);
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS app_notifications_active_user_idx
  ON public.app_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS app_notifications_entity_idx
  ON public.app_notifications (entity_type, entity_id, created_at DESC)
  WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.app_access_reviews TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.app_access_review_items TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.app_notifications TO cerp_app;
  ELSE
    RAISE NOTICE 'role cerp_app absent — aucun grant appliqué';
  END IF;
END
$grants$;

COMMENT ON TABLE public.app_access_reviews IS
  'SOL-25 periodic access reviews. Review creation snapshots access signals; it never changes or deletes an account automatically.';
COMMENT ON TABLE public.app_access_review_items IS
  'SOL-25 immutable review scope plus one audited decision per account.';
COMMENT ON COLUMN public.app_notifications.module_key IS
  'Module used to suppress an action server-side when the recipient no longer has access.';

COMMIT;
