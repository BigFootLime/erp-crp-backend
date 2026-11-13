BEGIN;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'PROFESSIONAL';
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS individual_first_name text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS individual_last_name text NULL;
-- `vat_number`/`naf_code` are the canonical client fields used by current repositories.
-- Older isolated/bootstrap schemas can expose `tva_intracom`/`code_naf` instead.
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS vat_number text NULL;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS naf_code text NULL;
DO $client_person_types_backfill$
DECLARE
  has_legacy_vat boolean := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='tva_intracom');
  has_legacy_naf boolean := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='code_naf');
  assignments text := '';
BEGIN
  IF has_legacy_vat THEN
    assignments := 'vat_number = COALESCE(NULLIF(btrim(vat_number), ''''), NULLIF(btrim(tva_intracom), ''''))';
  END IF;
  IF has_legacy_naf THEN
    assignments := assignments || CASE WHEN assignments <> '' THEN ', ' ELSE '' END || 'naf_code = COALESCE(NULLIF(btrim(naf_code), ''''), NULLIF(btrim(code_naf), ''''))';
  END IF;
  IF assignments <> '' THEN
    EXECUTE 'UPDATE public.clients SET ' || assignments || ' WHERE customer_type = ''PROFESSIONAL''';
  END IF;
END
$client_person_types_backfill$;
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_customer_type_1454_ck;
DO $client_person_types_constraint$
DECLARE
  has_legacy_vat boolean := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='tva_intracom');
  has_legacy_naf boolean := EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='clients' AND column_name='code_naf');
  check_expression text := $$
    customer_type IN ('PROFESSIONAL','INDIVIDUAL')
    AND (customer_type <> 'INDIVIDUAL' OR (NULLIF(btrim(individual_first_name),'') IS NOT NULL AND NULLIF(btrim(individual_last_name),'') IS NOT NULL))
    AND (customer_type <> 'INDIVIDUAL' OR NULLIF(btrim(siret),'') IS NULL)
    AND (customer_type <> 'INDIVIDUAL' OR NULLIF(btrim(siren),'') IS NULL)
    AND (customer_type <> 'INDIVIDUAL' OR NULLIF(btrim(vat_number),'') IS NULL)
    AND (customer_type <> 'INDIVIDUAL' OR NULLIF(btrim(naf_code),'') IS NULL)
  $$;
BEGIN
  IF has_legacy_vat THEN check_expression := check_expression || $$
    AND (customer_type <> 'INDIVIDUAL' OR NULLIF(btrim(tva_intracom),'') IS NULL)
  $$; END IF;
  IF has_legacy_naf THEN check_expression := check_expression || $$
    AND (customer_type <> 'INDIVIDUAL' OR NULLIF(btrim(code_naf),'') IS NULL)
  $$; END IF;
  EXECUTE 'ALTER TABLE public.clients ADD CONSTRAINT clients_customer_type_1454_ck CHECK (' || check_expression || ')';
END
$client_person_types_constraint$;
COMMENT ON COLUMN public.clients.customer_type IS 'Explicit client identity type. Historical rows remain PROFESSIONAL; no personal identity is inferred.';
COMMIT;
