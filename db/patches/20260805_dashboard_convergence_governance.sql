-- Dashboard ARIANE/V2/Legacy convergence: privacy-preserving daily counters.
-- Additive only. No preference or dashboard surface is removed by this patch.

CREATE TABLE IF NOT EXISTS public.dashboard_usage_daily (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  experience text NOT NULL,
  event_type text NOT NULL,
  selection_source text NOT NULL,
  previous_experience text NOT NULL DEFAULT 'none',
  role_bucket text NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_usage_daily_pkey PRIMARY KEY (id),
  CONSTRAINT dashboard_usage_daily_experience_ck CHECK (experience IN ('ariane','v2','legacy')),
  CONSTRAINT dashboard_usage_daily_event_ck CHECK (event_type IN ('view','switch','deep_link','preference_migrated','fallback')),
  CONSTRAINT dashboard_usage_daily_source_ck CHECK (selection_source IN ('default','preference','query','switch','rollback','migration')),
  CONSTRAINT dashboard_usage_daily_previous_ck CHECK (previous_experience IN ('none','ariane','v2','legacy')),
  CONSTRAINT dashboard_usage_daily_role_ck CHECK (role_bucket IN ('direction','production','achats','qualite','operateur')),
  CONSTRAINT dashboard_usage_daily_count_ck CHECK (event_count >= 0),
  CONSTRAINT dashboard_usage_daily_bucket_key UNIQUE (
    usage_date, experience, event_type, selection_source, previous_experience, role_bucket
  )
);

CREATE INDEX IF NOT EXISTS dashboard_usage_daily_date_idx
  ON public.dashboard_usage_daily (usage_date DESC);

COMMENT ON TABLE public.dashboard_usage_daily IS
  'Aggregats journaliers de convergence dashboard; aucun user_id, IP, URL, user-agent ou texte libre.';

ALTER TABLE public.dashboard_usage_daily OWNER TO cerp_app;
REVOKE ALL ON TABLE public.dashboard_usage_daily FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dashboard_usage_daily TO cerp_app;
