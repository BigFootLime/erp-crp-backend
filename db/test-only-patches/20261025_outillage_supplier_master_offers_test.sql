-- #1762 — TEST ONLY. Tool supplier offers are links to the canonical supplier
-- catalogue; this deliberately stores no copied supplier, price or currency.
DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '20261025_outillage_supplier_master_offers_test is restricted to cerp_test';
  END IF;
  IF to_regclass('public.gestion_outils_outil') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL
     OR to_regclass('public.fournisseurs') IS NULL THEN
    RAISE EXCEPTION 'Tool and canonical supplier catalogue tables are required';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.outillage_tool_supplier_catalogue (
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  catalogue_id uuid NOT NULL REFERENCES public.fournisseur_catalogue(id) ON DELETE RESTRICT,
  source_kind varchar(20) NOT NULL DEFAULT 'CATALOGUE_PDF' CHECK (source_kind IN ('CATALOGUE_PDF','MANUAL')),
  source_note varchar(1000) NULL,
  source_document varchar(500) NULL,
  source_sha256 char(64) NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_page integer NULL CHECK (source_page > 0),
  source_rect jsonb NULL CHECK (jsonb_typeof(source_rect) = 'array' AND jsonb_array_length(source_rect) = 4),
  source_date date NULL,
  tax_basis varchar(16) NOT NULL DEFAULT 'UNKNOWN' CHECK (tax_basis IN ('HT','UNKNOWN')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  PRIMARY KEY (id_outil, catalogue_id),
  CHECK ((source_kind='CATALOGUE_PDF' AND source_document IS NOT NULL AND source_sha256 IS NOT NULL AND source_page IS NOT NULL AND source_rect IS NOT NULL)
    OR (source_kind='MANUAL' AND source_note IS NOT NULL AND length(btrim(source_note)) >= 3 AND source_document IS NULL AND source_sha256 IS NULL AND source_page IS NULL AND source_rect IS NULL))
);

-- Actual purchase evidence is intentionally separate. Do not insert catalogue
-- prices here: a real price requires an explicit date, currency, unit and HT.
CREATE TABLE IF NOT EXISTS public.outillage_tool_actual_purchase_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE RESTRICT,
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  quantite integer NOT NULL CHECK (quantite > 0),
  prix_unitaire_ht numeric(18,4) NOT NULL CHECK (prix_unitaire_ht >= 0),
  devise varchar(10) NOT NULL,
  unite varchar(30) NOT NULL,
  purchased_at date NOT NULL,
  purchase_source_ref varchar(200) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  UNIQUE (id_outil, fournisseur_id, purchase_source_ref)
);

CREATE TABLE IF NOT EXISTS public.outillage_tool_receipt_idempotence (
  actor_id integer NOT NULL,
  idempotency_key varchar(200) NOT NULL,
  request_hash char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS outillage_tool_supplier_catalogue_catalogue_idx
  ON public.outillage_tool_supplier_catalogue (catalogue_id);

CREATE TABLE IF NOT EXISTS public.outillage_fabricant_fournisseur_master (
  id_fabricant integer NOT NULL REFERENCES public.gestion_outils_fabricant(id_fabricant) ON DELETE CASCADE,
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL,
  PRIMARY KEY (id_fabricant, fournisseur_id)
);

CREATE TABLE IF NOT EXISTS public.outillage_tool_fournisseur_master (
  id_outil integer NOT NULL REFERENCES public.gestion_outils_outil(id_outil) ON DELETE CASCADE,
  fournisseur_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id_outil, fournisseur_id)
);

-- Historical catalogue prices are supplier offers, not purchase receipts.
COMMENT ON TABLE public.outillage_tool_supplier_catalogue IS
  'TEST-only #1762 links: canonical fournisseur_catalogue OUTILLAGE entries associated with tools; prices remain indicative offers.';
