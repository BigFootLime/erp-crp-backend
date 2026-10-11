-- #1219: allow audited issuer qualifications through the existing directory command ledger.
ALTER TABLE public.einvoice_directory_verification_commands
  DROP CONSTRAINT IF EXISTS einvoice_directory_verification_resource_599_ck;
ALTER TABLE public.einvoice_directory_verification_commands
  ADD CONSTRAINT einvoice_directory_verification_resource_599_ck
    CHECK (resource_type IN ('CLIENT', 'FOURNISSEUR', 'ISSUER'));
