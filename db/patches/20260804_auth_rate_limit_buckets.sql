BEGIN;

-- SEC-CERP-0005: shared fixed-window counters for every backend replica.
-- `subject_hash` is an HMAC-SHA256 digest. Raw IPs, emails, usernames and reset
-- tokens must never be written to this table.
CREATE TABLE IF NOT EXISTS public.auth_rate_limit_buckets (
  scope text NOT NULL,
  subject_hash character(64) NOT NULL,
  request_count integer NOT NULL,
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT auth_rate_limit_buckets_pk PRIMARY KEY (scope, subject_hash),
  CONSTRAINT auth_rate_limit_buckets_scope_ck
    CHECK (scope ~ '^[a-z][a-z0-9:_-]{2,63}$'),
  CONSTRAINT auth_rate_limit_buckets_subject_hash_ck
    CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_rate_limit_buckets_count_ck
    CHECK (request_count > 0),
  CONSTRAINT auth_rate_limit_buckets_window_ck
    CHECK (expires_at > window_started_at)
);

COMMENT ON TABLE public.auth_rate_limit_buckets IS
  'SEC-CERP-0005 shared auth throttling counters; HMAC pseudonyms only, no raw PII';
COMMENT ON COLUMN public.auth_rate_limit_buckets.subject_hash IS
  'HMAC-SHA256(scope and normalized subject); never a raw IP, email, username or token';

CREATE INDEX IF NOT EXISTS auth_rate_limit_buckets_expires_at_idx
  ON public.auth_rate_limit_buckets (expires_at);

DO $grant$
BEGIN
  IF to_regrole('cerp_app') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.auth_rate_limit_buckets TO cerp_app;
  END IF;
END
$grant$;

COMMIT;
