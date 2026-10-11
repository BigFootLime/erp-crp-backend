BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.einvoice_directory_verification_commands WHERE resource_type = 'ISSUER') THEN
    RAISE EXCEPTION 'Issuer qualifications exist; keep the additive constraint and roll back application code only';
  END IF;
END $$;
ALTER TABLE public.einvoice_directory_verification_commands DROP CONSTRAINT einvoice_directory_verification_resource_599_ck;
ALTER TABLE public.einvoice_directory_verification_commands ADD CONSTRAINT einvoice_directory_verification_resource_599_ck CHECK (resource_type IN ('CLIENT', 'FOURNISSEUR'));
COMMIT;
