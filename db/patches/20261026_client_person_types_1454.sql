BEGIN;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'PROFESSIONAL';
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS individual_first_name text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS individual_last_name text NULL;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_customer_type_1454_ck;
ALTER TABLE public.clients ADD CONSTRAINT clients_customer_type_1454_ck CHECK (
  customer_type IN ('PROFESSIONAL','INDIVIDUAL')
  AND (customer_type <> 'INDIVIDUAL' OR (NULLIF(btrim(individual_first_name),'') IS NOT NULL AND NULLIF(btrim(individual_last_name),'') IS NOT NULL))
  AND (customer_type <> 'INDIVIDUAL' OR COALESCE(NULLIF(btrim(siret),''),NULL) IS NULL)
  AND (customer_type <> 'INDIVIDUAL' OR COALESCE(NULLIF(btrim(siren),''),NULL) IS NULL)
  AND (customer_type <> 'INDIVIDUAL' OR COALESCE(NULLIF(btrim(vat_number),''),NULL) IS NULL)
  AND (customer_type <> 'INDIVIDUAL' OR COALESCE(NULLIF(btrim(naf_code),''),NULL) IS NULL)
);
COMMENT ON COLUMN public.clients.customer_type IS 'Explicit client identity type. Historical rows remain PROFESSIONAL; no personal identity is inferred.';
COMMIT;
