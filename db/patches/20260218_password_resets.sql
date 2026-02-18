BEGIN;

-- Password reset flow (token stored hashed, expires quickly, single-use)

CREATE TABLE IF NOT EXISTS public.password_resets (
  id uuid PRIMARY KEY,
  user_id int NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamp without time zone NOT NULL,
  used boolean NOT NULL DEFAULT FALSE,
  created_at timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_id_idx ON public.password_resets(user_id);
CREATE INDEX IF NOT EXISTS password_resets_expires_at_idx ON public.password_resets(expires_at);
CREATE INDEX IF NOT EXISTS password_resets_token_hash_idx ON public.password_resets(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS password_resets_user_token_hash_uq ON public.password_resets(user_id, token_hash);

COMMIT;
