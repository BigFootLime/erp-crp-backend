CREATE TABLE public.client_demand_notification_emails (
  notification_id UUID PRIMARY KEY REFERENCES public.app_notifications(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','RETRY','SENT','FAILED','SKIPPED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX client_demand_notification_emails_due_idx
  ON public.client_demand_notification_emails (next_attempt, notification_id)
  WHERE status IN ('PENDING','PROCESSING','RETRY');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.client_demand_notification_emails TO cerp_app;
  END IF;
END $$;
