-- #1038: additive, opt-in Android terminals. No production data is backfilled.
BEGIN;
CREATE TABLE IF NOT EXISTS public.cerp_terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL UNIQUE REFERENCES public.production_devices(id),
  kind text NOT NULL CHECK(kind IN ('OPERATOR','TOOLING','MATERIAL','ARTICLES')),
  site_code text NOT NULL CHECK(length(btrim(site_code)) BETWEEN 1 AND 64),
  warehouse_id uuid,
  device_token_hash text UNIQUE,
  paired_at timestamptz,
  revoked_at timestamptz,
  scanner_prefix text NOT NULL DEFAULT '',
  scanner_suffix text NOT NULL DEFAULT 'ENTER',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.cerp_terminal_pairings (
  token_hash text PRIMARY KEY,
  terminal_id uuid NOT NULL REFERENCES public.cerp_terminals(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_by integer NOT NULL REFERENCES public.users(id)
);
CREATE TABLE IF NOT EXISTS public.cerp_terminal_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_code text NOT NULL,
  user_id integer NOT NULL REFERENCES public.users(id),
  pin_hash text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cerp_terminal_pin_unique ON public.cerp_terminal_pins(site_code,pin_hash) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cerp_terminal_user_pin_unique ON public.cerp_terminal_pins(site_code,user_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS public.cerp_terminal_sessions (
  session_id uuid PRIMARY KEY REFERENCES public.operator_device_sessions(id),
  terminal_id uuid NOT NULL REFERENCES public.cerp_terminals(id),
  pin_id uuid NOT NULL REFERENCES public.cerp_terminal_pins(id),
  account_epoch bigint NOT NULL,
  last_input_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.cerp_terminal_rate_limits (
  bucket text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
CREATE TABLE IF NOT EXISTS public.cerp_terminal_program_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terminal_id uuid NOT NULL REFERENCES public.cerp_terminals(id),
  operator_id integer NOT NULL REFERENCES public.users(id),
  machine_id uuid NOT NULL REFERENCES public.machines(id),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  operation_id uuid NOT NULL REFERENCES public.of_operations(id),
  program_fingerprint text NOT NULL,
  program_reference text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS public.cerp_terminal_audit (
  id bigserial PRIMARY KEY,
  terminal_id uuid REFERENCES public.cerp_terminals(id),
  actor_id integer REFERENCES public.users(id),
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.cerp_terminal_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Terminal audit records are immutable'; END $$;
DROP TRIGGER IF EXISTS cerp_terminal_audit_no_change ON public.cerp_terminal_audit;
CREATE TRIGGER cerp_terminal_audit_no_change BEFORE UPDATE OR DELETE ON public.cerp_terminal_audit
FOR EACH ROW EXECUTE FUNCTION public.cerp_terminal_audit_immutable();
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
  GRANT SELECT,INSERT,UPDATE ON public.cerp_terminals,public.cerp_terminal_pairings,public.cerp_terminal_pins,
    public.cerp_terminal_sessions,public.cerp_terminal_rate_limits TO cerp_app;
  GRANT SELECT,INSERT ON public.cerp_terminal_program_confirmations,public.cerp_terminal_audit TO cerp_app;
  GRANT USAGE,SELECT ON SEQUENCE public.cerp_terminal_audit_id_seq TO cerp_app;
 END IF;
END $$;
COMMIT;
