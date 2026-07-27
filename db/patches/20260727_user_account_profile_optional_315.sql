-- Issue #315 — sépare la création d'un compte ERP de la complétude du dossier RH.
-- Les contraintes UNIQUE restent en place : plusieurs valeurs NULL sont permises,
-- mais deux vraies valeurs identiques restent interdites.

BEGIN;

ALTER TABLE public.users
  ALTER COLUMN tel_no DROP NOT NULL,
  ALTER COLUMN gender DROP NOT NULL,
  ALTER COLUMN address DROP NOT NULL,
  ALTER COLUMN lane DROP NOT NULL,
  ALTER COLUMN house_no DROP NOT NULL,
  ALTER COLUMN postcode DROP NOT NULL,
  ALTER COLUMN date_of_birth DROP NOT NULL,
  ALTER COLUMN social_security_number DROP NOT NULL;

COMMENT ON COLUMN public.users.tel_no IS
  'Optional during ERP account provisioning; complete with verified HR data later.';
COMMENT ON COLUMN public.users.social_security_number IS
  'Restricted HR identifier; never fabricate it for account provisioning.';

COMMIT;
