-- #1454 commercial intercompany catalogue and dropship purchase links.
-- Additive only. This schema deliberately reuses articles, fournisseurs and
-- commande aggregates; it never introduces a parallel catalogue or stock flow.
BEGIN;

DO $$ BEGIN
  IF to_regclass('public.articles') IS NULL OR to_regclass('public.fournisseurs') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL
     OR to_regclass('public.commande_client') IS NULL
     OR to_regclass('public.commande_ligne') IS NULL
     OR to_regclass('public.commande_fournisseur') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL THEN
    RAISE EXCEPTION '#1454 intercompany catalogue prerequisites are missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.intercompany_supplier_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_company_id uuid NOT NULL,
  supplier_company_id uuid NOT NULL,
  environment text NOT NULL,
  local_supplier_id uuid NOT NULL REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
  local_customer_id text NOT NULL REFERENCES public.clients(client_id) ON DELETE RESTRICT,
  approval_profile_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'ACTIVE',
  currency text NOT NULL DEFAULT 'EUR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT intercompany_supplier_relation_distinct_ck CHECK (buyer_company_id <> supplier_company_id),
  CONSTRAINT intercompany_supplier_relation_environment_ck CHECK (environment IN ('cerp_prod','cerp_test')),
  CONSTRAINT intercompany_supplier_relation_status_ck CHECK (status IN ('ACTIVE','SUSPENDED','RETIRED')),
  CONSTRAINT intercompany_supplier_relation_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT intercompany_supplier_relation_approval_profiles_ck CHECK (status <> 'ACTIVE' OR cardinality(approval_profile_ids) > 0),
  CONSTRAINT intercompany_supplier_relation_pair_uq UNIQUE (buyer_company_id,supplier_company_id,environment)
);

CREATE TABLE IF NOT EXISTS public.intercompany_commercial_catalogue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relation_id uuid NOT NULL REFERENCES public.intercompany_supplier_relations(id) ON DELETE RESTRICT,
  local_article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  supplier_catalogue_id uuid NOT NULL REFERENCES public.fournisseur_catalogue(id) ON DELETE RESTRICT,
  supplier_catalogue_mapping_id uuid NOT NULL,
  supplier_article_id uuid NOT NULL,
  supplier_piece_technique_id uuid NULL,
  supplier_piece_technique_version_id uuid NULL,
  supplier_reference text NULL,
  designation text NOT NULL,
  unit text NOT NULL,
  buyer_sale_unit_price numeric(14,4) NOT NULL,
  buyer_sale_vat_rate numeric(5,2) NOT NULL DEFAULT 20,
  purchase_unit_price numeric(14,4) NOT NULL,
  purchase_vat_rate numeric(5,2) NOT NULL DEFAULT 20,
  currency text NOT NULL DEFAULT 'EUR',
  version integer NOT NULL DEFAULT 1,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT intercompany_commercial_catalogue_prices_ck CHECK (buyer_sale_unit_price >= 0 AND purchase_unit_price >= 0),
  CONSTRAINT intercompany_commercial_catalogue_vat_ck CHECK (buyer_sale_vat_rate BETWEEN 0 AND 100 AND purchase_vat_rate BETWEEN 0 AND 100),
  CONSTRAINT intercompany_commercial_catalogue_version_ck CHECK (version > 0),
  CONSTRAINT intercompany_commercial_catalogue_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT intercompany_commercial_catalogue_supplier_binding_uq UNIQUE (relation_id,supplier_catalogue_mapping_id)
);
CREATE INDEX IF NOT EXISTS intercompany_commercial_catalogue_relation_idx ON public.intercompany_commercial_catalogue(relation_id) WHERE active;
CREATE INDEX IF NOT EXISTS intercompany_commercial_catalogue_article_idx ON public.intercompany_commercial_catalogue(local_article_id) WHERE active;

ALTER TABLE public.commande_client ADD COLUMN IF NOT EXISTS fulfilment_mode text NOT NULL DEFAULT 'STANDARD';
ALTER TABLE public.commande_client ADD COLUMN IF NOT EXISTS intercompany_delivery_address jsonb NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='commande_client_fulfilment_mode_ck') THEN
    ALTER TABLE public.commande_client ADD CONSTRAINT commande_client_fulfilment_mode_ck CHECK (fulfilment_mode IN ('STANDARD','SUPPLIER_DROPSHIP'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.intercompany_purchase_order_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_sales_order_id bigint NOT NULL REFERENCES public.commande_client(id) ON DELETE RESTRICT,
  buyer_purchase_order_id uuid NOT NULL REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  relation_id uuid NOT NULL REFERENCES public.intercompany_supplier_relations(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT intercompany_purchase_order_buyer_sales_uq UNIQUE (buyer_sales_order_id),
  CONSTRAINT intercompany_purchase_order_buyer_purchase_uq UNIQUE (buyer_purchase_order_id)
);

CREATE TABLE IF NOT EXISTS public.intercompany_purchase_order_line_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_sales_order_line_id bigint NOT NULL REFERENCES public.commande_ligne(id) ON DELETE RESTRICT,
  buyer_purchase_order_line_id uuid NOT NULL REFERENCES public.commande_fournisseur_ligne(id) ON DELETE RESTRICT,
  catalogue_mapping_id uuid NOT NULL REFERENCES public.intercompany_commercial_catalogue(id) ON DELETE RESTRICT,
  mapping_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intercompany_purchase_order_line_buyer_sales_uq UNIQUE (buyer_sales_order_line_id),
  CONSTRAINT intercompany_purchase_order_line_buyer_purchase_uq UNIQUE (buyer_purchase_order_line_id),
  CONSTRAINT intercompany_purchase_order_line_version_ck CHECK (mapping_version > 0)
);

COMMIT;
