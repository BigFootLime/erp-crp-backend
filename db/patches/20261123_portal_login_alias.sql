ALTER TABLE public.client_portal_accounts
  ADD COLUMN login_alias TEXT,
  ADD CONSTRAINT client_portal_accounts_login_alias_ck
    CHECK (login_alias IS NULL OR login_alias ~ '^[A-Z][A-Z0-9_-]{2,31}$');

CREATE UNIQUE INDEX client_portal_accounts_login_alias_uq
  ON public.client_portal_accounts (login_alias)
  WHERE login_alias IS NOT NULL AND status <> 'REVOKED';
