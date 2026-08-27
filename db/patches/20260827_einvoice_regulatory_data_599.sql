-- EINV-599 — BT-23, explicit electronic routing addresses and immutable regulatory snapshots.
-- Additive only: no existing invoice, client, supplier or issuer value is inferred or backfilled.

BEGIN;

CREATE TABLE IF NOT EXISTS public.einvoice_billing_frame_catalog (
  catalog_version text NOT NULL,
  code text NOT NULL,
  operation_category text NOT NULL,
  label_fr text NOT NULL,
  source_reference text NOT NULL,
  effective_from date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_billing_frame_catalog_599_pk PRIMARY KEY (catalog_version, code),
  CONSTRAINT einvoice_billing_frame_code_599_ck CHECK (code ~ '^[BSM][0-9]+$'),
  CONSTRAINT einvoice_billing_frame_operation_599_ck
    CHECK (operation_category IN ('GOODS','SERVICES','MIXED')),
  CONSTRAINT einvoice_billing_frame_label_599_ck CHECK (btrim(label_fr) <> ''),
  CONSTRAINT einvoice_billing_frame_source_599_ck CHECK (btrim(source_reference) <> '')
);

INSERT INTO public.einvoice_billing_frame_catalog (
  catalog_version, code, operation_category, label_fr, source_reference, effective_from
)
VALUES
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','B1','GOODS','Facture de biens','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','S1','SERVICES','Facture de prestations de services','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','M1','MIXED','Facture mixte de biens et services','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','B2','GOODS','Facture de biens déjà payée','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','S2','SERVICES','Facture de services déjà payée','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','M2','MIXED','Facture mixte déjà payée','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','B4','GOODS','Facture définitive de biens après acompte','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','S4','SERVICES','Facture définitive de services après acompte','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','M4','MIXED','Facture définitive mixte après acompte','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','S5','SERVICES','Facture de sous-traitance','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','S6','SERVICES','Facture de cotraitance','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','B7','GOODS','Facture de biens déjà déclarée en e-reporting','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30'),
  ('AFNOR-XP-Z12-012-DGFIP-V3.2-2026-04-30','S7','SERVICES','Facture de services déjà déclarée en e-reporting','DGFiP V3.2 / AFNOR XP Z12-012 — BT-23','2026-04-30')
ON CONFLICT (catalog_version, code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_einvoice_reference_append_only_599()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'EINV-599 versioned electronic-invoice reference data is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_einvoice_billing_frame_append_only_599
  ON public.einvoice_billing_frame_catalog;
CREATE TRIGGER trg_einvoice_billing_frame_append_only_599
BEFORE UPDATE OR DELETE ON public.einvoice_billing_frame_catalog
FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_reference_append_only_599();

CREATE TABLE IF NOT EXISTS public.einvoice_directory_verification_commands (
  idempotency_key text PRIMARY KEY,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  actor_user_id bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT einvoice_directory_verification_resource_599_ck
    CHECK (resource_type IN ('CLIENT','FOURNISSEUR')),
  CONSTRAINT einvoice_directory_verification_key_599_ck CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT einvoice_directory_verification_hash_599_ck CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT einvoice_directory_verification_result_599_ck CHECK (jsonb_typeof(result) = 'object')
);

DROP TRIGGER IF EXISTS trg_einvoice_directory_verification_append_only_599
  ON public.einvoice_directory_verification_commands;
CREATE TRIGGER trg_einvoice_directory_verification_append_only_599
BEFORE UPDATE OR DELETE ON public.einvoice_directory_verification_commands
FOR EACH ROW EXECUTE FUNCTION public.fn_einvoice_reference_append_only_599();

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS siren text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS electronic_address_scheme text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS electronic_address_value text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS electronic_address_directory_entry_id text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS electronic_address_verified_at timestamptz NULL;

ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS siren text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS compte_tiers text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS electronic_address_scheme text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS electronic_address_value text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS electronic_address_directory_entry_id text NULL;
ALTER TABLE public.fournisseurs ADD COLUMN IF NOT EXISTS electronic_address_verified_at timestamptz NULL;

ALTER TABLE public.finance_legal_mentions ADD COLUMN IF NOT EXISTS electronic_address_scheme text NULL;
ALTER TABLE public.finance_legal_mentions ADD COLUMN IF NOT EXISTS electronic_address_value text NULL;
ALTER TABLE public.finance_legal_mentions ADD COLUMN IF NOT EXISTS electronic_address_directory_entry_id text NULL;
ALTER TABLE public.finance_legal_mentions ADD COLUMN IF NOT EXISTS electronic_address_verified_at timestamptz NULL;

ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS billing_frame_catalog_version text NULL;
ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS billing_frame_code text NULL;
ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS operation_category text NULL;
ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS transaction_scope text NULL;
ALTER TABLE public.facture ADD COLUMN IF NOT EXISTS regulatory_snapshot jsonb NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_siren_599_ck') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_siren_599_ck
      CHECK (siren IS NULL OR siren ~ '^[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_electronic_address_599_ck') THEN
    ALTER TABLE public.clients ADD CONSTRAINT clients_electronic_address_599_ck CHECK (
      (electronic_address_scheme IS NULL AND electronic_address_value IS NULL
       AND electronic_address_directory_entry_id IS NULL AND electronic_address_verified_at IS NULL)
      OR
      (electronic_address_scheme ~ '^[0-9A-Z]{4}$'
       AND btrim(electronic_address_value) <> ''
       AND electronic_address_value !~ '[[:space:][:cntrl:]]'
       AND (electronic_address_directory_entry_id IS NULL OR btrim(electronic_address_directory_entry_id) <> '')
       AND (electronic_address_verified_at IS NULL OR electronic_address_directory_entry_id IS NOT NULL))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseurs_siren_599_ck') THEN
    ALTER TABLE public.fournisseurs ADD CONSTRAINT fournisseurs_siren_599_ck
      CHECK (siren IS NULL OR siren ~ '^[0-9]{9}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseurs_electronic_address_599_ck') THEN
    ALTER TABLE public.fournisseurs ADD CONSTRAINT fournisseurs_electronic_address_599_ck CHECK (
      (electronic_address_scheme IS NULL AND electronic_address_value IS NULL
       AND electronic_address_directory_entry_id IS NULL AND electronic_address_verified_at IS NULL)
      OR
      (electronic_address_scheme ~ '^[0-9A-Z]{4}$'
       AND btrim(electronic_address_value) <> ''
       AND electronic_address_value !~ '[[:space:][:cntrl:]]'
       AND (electronic_address_directory_entry_id IS NULL OR btrim(electronic_address_directory_entry_id) <> '')
       AND (electronic_address_verified_at IS NULL OR electronic_address_directory_entry_id IS NOT NULL))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_legal_mentions_electronic_address_599_ck') THEN
    ALTER TABLE public.finance_legal_mentions ADD CONSTRAINT finance_legal_mentions_electronic_address_599_ck CHECK (
      (electronic_address_scheme IS NULL AND electronic_address_value IS NULL
       AND electronic_address_directory_entry_id IS NULL AND electronic_address_verified_at IS NULL)
      OR
      (electronic_address_scheme ~ '^[0-9A-Z]{4}$'
       AND btrim(electronic_address_value) <> ''
       AND electronic_address_value !~ '[[:space:][:cntrl:]]'
       AND (electronic_address_directory_entry_id IS NULL OR btrim(electronic_address_directory_entry_id) <> '')
       AND (electronic_address_verified_at IS NULL OR electronic_address_directory_entry_id IS NOT NULL))
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_regulatory_fields_599_ck') THEN
    ALTER TABLE public.facture ADD CONSTRAINT facture_regulatory_fields_599_ck CHECK (
      (billing_frame_catalog_version IS NULL AND billing_frame_code IS NULL
       AND operation_category IS NULL AND transaction_scope IS NULL AND regulatory_snapshot IS NULL)
      OR
      (billing_frame_catalog_version IS NOT NULL AND billing_frame_code IS NOT NULL
       AND operation_category IN ('GOODS','SERVICES','MIXED')
       AND transaction_scope IN ('FR_PRIVATE_B2B','FR_PUBLIC','FOREIGN_B2B','B2C','OUT_OF_SCOPE')
       AND jsonb_typeof(regulatory_snapshot) = 'object')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'facture_billing_frame_599_fk') THEN
    ALTER TABLE public.facture ADD CONSTRAINT facture_billing_frame_599_fk
      FOREIGN KEY (billing_frame_catalog_version, billing_frame_code)
      REFERENCES public.einvoice_billing_frame_catalog(catalog_version, code);
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS clients_siren_599_idx ON public.clients (siren) WHERE siren IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_electronic_address_599_idx
  ON public.clients (electronic_address_scheme, electronic_address_value)
  WHERE electronic_address_scheme IS NOT NULL;
CREATE INDEX IF NOT EXISTS fournisseurs_siren_599_idx ON public.fournisseurs (siren) WHERE siren IS NOT NULL;
CREATE INDEX IF NOT EXISTS fournisseurs_electronic_address_599_idx
  ON public.fournisseurs (electronic_address_scheme, electronic_address_value)
  WHERE electronic_address_scheme IS NOT NULL;
CREATE INDEX IF NOT EXISTS facture_billing_frame_599_idx
  ON public.facture (billing_frame_catalog_version, billing_frame_code)
  WHERE billing_frame_code IS NOT NULL;

DO $owner$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    ALTER TABLE public.einvoice_billing_frame_catalog OWNER TO cerp_app;
    ALTER TABLE public.einvoice_directory_verification_commands OWNER TO cerp_app;
    ALTER FUNCTION public.fn_einvoice_reference_append_only_599() OWNER TO cerp_app;
    GRANT SELECT ON public.einvoice_billing_frame_catalog TO cerp_app;
    GRANT SELECT, INSERT ON public.einvoice_directory_verification_commands TO cerp_app;
  END IF;
END
$owner$;

COMMIT;
