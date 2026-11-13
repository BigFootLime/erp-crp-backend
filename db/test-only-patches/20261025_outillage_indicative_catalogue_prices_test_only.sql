-- TEST ONLY: immutable catalogue-price evidence.  Not a production migration.
BEGIN;
DO $$ BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Indicative catalogue prices patch is restricted to cerp_test';
  END IF;
  IF to_regclass('public.gestion_outils_outil') IS NULL OR to_regclass('public.fournisseur_catalogue') IS NULL THEN
    RAISE EXCEPTION 'Tool and canonical supplier catalogue tables are required';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.outillage_tool_indicative_catalogue_price (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(128) NOT NULL UNIQUE,
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  catalogue_id uuid NOT NULL REFERENCES public.fournisseur_catalogue(id) ON DELETE RESTRICT,
  unit_price numeric(12,3) NOT NULL CHECK (unit_price >= 0),
  currency varchar(10) NOT NULL,
  unit varchar(30) NOT NULL,
  price_type varchar(40) NOT NULL CHECK (price_type = 'CATALOGUE_INDICATIF'),
  source_document varchar(500) NOT NULL,
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_page integer NOT NULL CHECK (source_page > 0),
  source_rect jsonb NOT NULL CHECK (jsonb_typeof(source_rect) = 'array' AND jsonb_array_length(source_rect) = 4),
  source_coordinate_system varchar(40) NOT NULL DEFAULT 'PDF_POINTS_BOTTOM_LEFT' CHECK (source_coordinate_system='PDF_POINTS_BOTTOM_LEFT'),
  source_date date NULL,
  tax_basis varchar(16) NOT NULL CHECK (tax_basis IN ('HT','UNKNOWN')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outillage_indicative_price_tool_idx ON public.outillage_tool_indicative_catalogue_price(id_outil, imported_at DESC);
CREATE INDEX IF NOT EXISTS outillage_indicative_price_catalogue_idx ON public.outillage_tool_indicative_catalogue_price(catalogue_id, imported_at DESC);
COMMIT;
