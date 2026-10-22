-- #1710: staged, explicit CERP cutover numbering.
--
-- Applying this patch NEVER changes a live counter. Delivery and affair values
-- are proposals only (inactive); the SuperAdmin/MFA cutover command activates
-- them in its own audited transaction after the business has frozen its Excel
-- registers. Existing installations continue using their legacy generators.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cutover_business_number_sequences (
  scope text PRIMARY KEY CHECK (scope IN ('AFFAIRE_LIVRAISON', 'BON_LIVRAISON')),
  next_value bigint NOT NULL CHECK (next_value > 0),
  active boolean NOT NULL DEFAULT FALSE,
  activated_at timestamptz NULL,
  activated_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cutover_business_number_sequences_activation_ck CHECK (
    (active = FALSE AND activated_at IS NULL AND activated_by IS NULL)
    OR (active = TRUE AND activated_at IS NOT NULL AND activated_by IS NOT NULL)
  )
);

-- Proposed numbers agreed for CRP. ON CONFLICT intentionally preserves a
-- reviewed local proposal or an already activated sequence.
INSERT INTO public.cutover_business_number_sequences(scope, next_value, active)
VALUES
  ('AFFAIRE_LIVRAISON', 24000, FALSE),
  ('BON_LIVRAISON', 15000, FALSE)
ON CONFLICT (scope) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.cutover_finance_shared_sequences (
  entity_code text NOT NULL,
  period_key text NOT NULL CHECK (period_key ~ '^[0-9]{4}$'),
  next_value bigint NOT NULL CHECK (next_value > 0),
  facture_prefix text NOT NULL CHECK (facture_prefix ~ '^[A-Za-z0-9._/-]{1,60}$'),
  avoir_prefix text NOT NULL CHECK (avoir_prefix ~ '^[A-Za-z0-9._/-]{1,60}$'),
  padding integer NOT NULL CHECK (padding BETWEEN 1 AND 12),
  active boolean NOT NULL DEFAULT FALSE,
  activated_at timestamptz NULL,
  activated_by integer NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  activation_evidence_reference text NULL CHECK (activation_evidence_reference IS NULL OR length(btrim(activation_evidence_reference)) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_code, period_key),
  CONSTRAINT cutover_finance_shared_sequences_activation_ck CHECK (
    (active = FALSE AND activated_at IS NULL AND activated_by IS NULL AND activation_evidence_reference IS NULL)
    OR (active = TRUE AND activated_at IS NOT NULL AND activated_by IS NOT NULL AND activation_evidence_reference IS NOT NULL)
  )
);

COMMENT ON TABLE public.cutover_business_number_sequences IS
  'Explicitly activated delivery-affair and delivery-note counters for #1710; inactive rows retain legacy numbering.';
COMMENT ON TABLE public.cutover_finance_shared_sequences IS
  'Optional post-cutover shared fiscal sequence for invoices (including advances) and credit notes. Proformas remain on proforma_client_reference_seq.';

-- The application needs to allocate only after the separately controlled
-- activation; no application role receives DELETE/TRUNCATE privileges here.
GRANT SELECT, UPDATE ON public.cutover_business_number_sequences TO cerp_app;
GRANT SELECT, INSERT, UPDATE ON public.cutover_finance_shared_sequences TO cerp_app;
REVOKE DELETE, TRUNCATE ON public.cutover_business_number_sequences, public.cutover_finance_shared_sequences FROM PUBLIC, cerp_app;

COMMIT;
