-- 20260312_planning_notifications_ar.sql
-- Planning / notifications / AR workflow support.

/* -------------------------------------------------------------------------- */
/* 1) Planning events: operator assignment                                     */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.planning_events
ADD COLUMN IF NOT EXISTS operator_id INTEGER NULL;

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'planning_events_operator_id_fkey'
      AND conrelid = 'public.planning_events'::regclass
  ) THEN
    ALTER TABLE public.planning_events
    ADD CONSTRAINT planning_events_operator_id_fkey
    FOREIGN KEY (operator_id) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS planning_events_operator_id_idx
ON public.planning_events (operator_id)
WHERE operator_id IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 2) In-app notifications                                                     */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.app_notifications (
  id UUID NOT NULL,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  action_url TEXT NULL,
  action_label TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ NULL,
  read_by INTEGER NULL,
  CONSTRAINT app_notifications_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    EXECUTE 'ALTER TABLE public.app_notifications ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
    EXECUTE 'ALTER TABLE public.app_notifications ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_notifications_user_id_fkey'
      AND conrelid = 'public.app_notifications'::regclass
  ) THEN
    ALTER TABLE public.app_notifications
    ADD CONSTRAINT app_notifications_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_notifications_read_by_fkey'
      AND conrelid = 'public.app_notifications'::regclass
  ) THEN
    ALTER TABLE public.app_notifications
    ADD CONSTRAINT app_notifications_read_by_fkey
    FOREIGN KEY (read_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_notifications_severity_check'
      AND conrelid = 'public.app_notifications'::regclass
  ) THEN
    ALTER TABLE public.app_notifications
    ADD CONSTRAINT app_notifications_severity_check
    CHECK (severity IN ('info', 'success', 'warning', 'error'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS app_notifications_user_created_idx
ON public.app_notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS app_notifications_user_unread_idx
ON public.app_notifications (user_id, created_at DESC)
WHERE read_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_notifications_user_dedupe_idx
ON public.app_notifications (user_id, dedupe_key)
WHERE dedupe_key IS NOT NULL;

/* -------------------------------------------------------------------------- */
/* 3) Commande AR workflow log                                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.commande_ar_log (
  id UUID NOT NULL,
  commande_id BIGINT NOT NULL,
  document_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'GENERATED',
  subject TEXT NULL,
  body_text TEXT NULL,
  recipient_emails TEXT[] NOT NULL DEFAULT '{}'::text[],
  recipient_contact_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by INTEGER NULL,
  sent_at TIMESTAMPTZ NULL,
  sent_by INTEGER NULL,
  email_provider_id TEXT NULL,
  error_message TEXT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT commande_ar_log_pkey PRIMARY KEY (id)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    EXECUTE 'ALTER TABLE public.commande_ar_log ALTER COLUMN id SET DEFAULT gen_random_uuid()';
  ELSIF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuid_generate_v4') THEN
    EXECUTE 'ALTER TABLE public.commande_ar_log ALTER COLUMN id SET DEFAULT uuid_generate_v4()';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.commande_client') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_ar_log_commande_id_fkey'
      AND conrelid = 'public.commande_ar_log'::regclass
  ) THEN
    ALTER TABLE public.commande_ar_log
    ADD CONSTRAINT commande_ar_log_commande_id_fkey
    FOREIGN KEY (commande_id) REFERENCES public.commande_client(id) ON DELETE CASCADE;
  END IF;

  IF to_regclass('public.documents_clients') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_ar_log_document_id_fkey'
      AND conrelid = 'public.commande_ar_log'::regclass
  ) THEN
    ALTER TABLE public.commande_ar_log
    ADD CONSTRAINT commande_ar_log_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES public.documents_clients(id) ON DELETE RESTRICT;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_ar_log_generated_by_fkey'
      AND conrelid = 'public.commande_ar_log'::regclass
  ) THEN
    ALTER TABLE public.commande_ar_log
    ADD CONSTRAINT commande_ar_log_generated_by_fkey
    FOREIGN KEY (generated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_ar_log_sent_by_fkey'
      AND conrelid = 'public.commande_ar_log'::regclass
  ) THEN
    ALTER TABLE public.commande_ar_log
    ADD CONSTRAINT commande_ar_log_sent_by_fkey
    FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'commande_ar_log_status_check'
      AND conrelid = 'public.commande_ar_log'::regclass
  ) THEN
    ALTER TABLE public.commande_ar_log
    ADD CONSTRAINT commande_ar_log_status_check
    CHECK (status IN ('GENERATED', 'SENT', 'FAILED'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commande_ar_log_commande_created_idx
ON public.commande_ar_log (commande_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS commande_ar_log_sent_idx
ON public.commande_ar_log (sent_at DESC)
WHERE sent_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS commande_ar_log_document_idx
ON public.commande_ar_log (document_id);
