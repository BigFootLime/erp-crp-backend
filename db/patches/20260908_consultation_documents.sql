-- Immutable document-version references on each prepared supplier request.
BEGIN;
ALTER TABLE public.supplier_consultation_invitations ADD COLUMN IF NOT EXISTS documents jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK(jsonb_typeof(documents)='array');
COMMIT;
