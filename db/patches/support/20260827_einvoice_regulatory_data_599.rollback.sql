\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() !~ '(^|_)test($|_)|isolated|sandbox' THEN
    RAISE EXCEPTION 'EINV-599 rollback is allowed only on an isolated/test database; restore the pre-migration backup in production';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.facture
    WHERE regulatory_snapshot IS NOT NULL OR billing_frame_code IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.clients
    WHERE siren IS NOT NULL OR electronic_address_scheme IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.fournisseurs
    WHERE siren IS NOT NULL OR compte_tiers IS NOT NULL OR electronic_address_scheme IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.finance_legal_mentions
    WHERE electronic_address_scheme IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.einvoice_directory_verification_commands
  ) THEN
    RAISE EXCEPTION 'EINV-599 rollback refused because qualified regulatory data exists; restore the backup instead';
  END IF;
END
$guard$;

BEGIN;
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_billing_frame_599_fk;
ALTER TABLE public.facture DROP CONSTRAINT IF EXISTS facture_regulatory_fields_599_ck;
ALTER TABLE public.facture
  DROP COLUMN IF EXISTS regulatory_snapshot,
  DROP COLUMN IF EXISTS transaction_scope,
  DROP COLUMN IF EXISTS operation_category,
  DROP COLUMN IF EXISTS billing_frame_code,
  DROP COLUMN IF EXISTS billing_frame_catalog_version;
ALTER TABLE public.finance_legal_mentions
  DROP CONSTRAINT IF EXISTS finance_legal_mentions_electronic_address_599_ck,
  DROP COLUMN IF EXISTS electronic_address_verified_at,
  DROP COLUMN IF EXISTS electronic_address_directory_entry_id,
  DROP COLUMN IF EXISTS electronic_address_value,
  DROP COLUMN IF EXISTS electronic_address_scheme;
ALTER TABLE public.fournisseurs
  DROP CONSTRAINT IF EXISTS fournisseurs_electronic_address_599_ck,
  DROP CONSTRAINT IF EXISTS fournisseurs_siren_599_ck,
  DROP COLUMN IF EXISTS electronic_address_verified_at,
  DROP COLUMN IF EXISTS electronic_address_directory_entry_id,
  DROP COLUMN IF EXISTS electronic_address_value,
  DROP COLUMN IF EXISTS electronic_address_scheme,
  DROP COLUMN IF EXISTS compte_tiers,
  DROP COLUMN IF EXISTS siren;
ALTER TABLE public.clients
  DROP CONSTRAINT IF EXISTS clients_electronic_address_599_ck,
  DROP CONSTRAINT IF EXISTS clients_siren_599_ck,
  DROP COLUMN IF EXISTS electronic_address_verified_at,
  DROP COLUMN IF EXISTS electronic_address_directory_entry_id,
  DROP COLUMN IF EXISTS electronic_address_value,
  DROP COLUMN IF EXISTS electronic_address_scheme,
  DROP COLUMN IF EXISTS siren;
DROP TABLE IF EXISTS public.einvoice_billing_frame_catalog;
DROP TABLE IF EXISTS public.einvoice_directory_verification_commands;
DROP FUNCTION IF EXISTS public.fn_einvoice_reference_append_only_599();
COMMIT;
