-- #767 / L3-L5. Canonical stock and purchase ledgers retain all quantities.
BEGIN;
CREATE TABLE IF NOT EXISTS public.of_material_needs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  source_ref text NOT NULL,
  technical_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id),
  technical_hash text NOT NULL,
  operation_id uuid REFERENCES public.of_operations(id) ON DELETE RESTRICT,
  article_id uuid REFERENCES public.articles(id),
  designation text NOT NULL,
  required_qty numeric(14,3) NOT NULL CHECK(required_qty>=0),
  unit text,
  supply_mode text NOT NULL DEFAULT 'PURCHASE' CHECK(supply_mode IN ('PURCHASE','CUSTOMER')),
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  specification_reviewed_at timestamptz,
  specification_reviewed_by integer REFERENCES public.users(id),
  debit_rule jsonb,
  allow_partial boolean NOT NULL DEFAULT false,
  supplier_id uuid REFERENCES public.fournisseurs(id),
  destination_id uuid REFERENCES public.magasins(id),
  row_version integer NOT NULL DEFAULT 1 CHECK(row_version>0),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES public.users(id),updated_by integer REFERENCES public.users(id),
  UNIQUE(of_id,technical_version_id,source_ref)
);
CREATE INDEX IF NOT EXISTS of_material_need_operation_idx ON public.of_material_needs(operation_id) WHERE superseded_at IS NULL;
ALTER TABLE public.stock_reservations ADD COLUMN IF NOT EXISTS material_need_id uuid REFERENCES public.of_material_needs(id);
CREATE INDEX IF NOT EXISTS stock_reservation_material_need_idx ON public.stock_reservations(material_need_id);
ALTER TABLE public.commande_fournisseur_ligne_besoin ADD COLUMN IF NOT EXISTS material_need_id uuid REFERENCES public.of_material_needs(id);
CREATE INDEX IF NOT EXISTS cf_besoin_material_need_idx ON public.commande_fournisseur_ligne_besoin(material_need_id);
-- Partial purchases are separate promises to the same need. Other existing
-- sources retain their unique live-link protection.
ALTER TABLE public.commande_fournisseur_ligne_besoin DROP CONSTRAINT IF EXISTS cf_ligne_besoin_type_chk;
ALTER TABLE public.commande_fournisseur_ligne_besoin ADD CONSTRAINT cf_ligne_besoin_type_chk CHECK(besoin_type IN ('PIECE_TECHNIQUE_ACHAT','STOCK_LEVEL','MANUEL','OF_MATERIAL'));
DROP INDEX IF EXISTS public.cf_ligne_besoin_couverture_uniq;
CREATE UNIQUE INDEX cf_ligne_besoin_couverture_uniq ON public.commande_fournisseur_ligne_besoin(besoin_type,besoin_ref,besoin_of_id) WHERE NOT annule AND besoin_type NOT IN ('MANUEL','OF_MATERIAL');
CREATE UNIQUE INDEX IF NOT EXISTS cf_material_line_need_idx ON public.commande_fournisseur_ligne_besoin(ligne_id,material_need_id) WHERE material_need_id IS NOT NULL AND NOT annule;
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS client_proprietaire_id varchar REFERENCES public.clients(client_id);
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS material_properties jsonb;
CREATE TABLE IF NOT EXISTS public.of_material_lot_checks (
  need_id uuid NOT NULL REFERENCES public.of_material_needs(id),
  lot_id uuid NOT NULL REFERENCES public.lots(id),
  requirements_hash text NOT NULL,
  evidence text NOT NULL CHECK(length(trim(evidence))>=3),
  decided_by integer NOT NULL REFERENCES public.users(id),decided_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(need_id,lot_id,requirements_hash)
);
-- Receipt transfers are immutable links to the existing reservation; this is
-- a replay receipt, never an independent stock or reservation balance.
CREATE TABLE IF NOT EXISTS public.of_material_receipt_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES public.reception_fournisseur_stock_receipts(id),
  purchase_need_id uuid NOT NULL REFERENCES public.commande_fournisseur_ligne_besoin(id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES public.stock_reservations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(receipt_id,purchase_need_id)
);
ALTER TABLE public.of_material_needs OWNER TO cerp_app;
ALTER TABLE public.of_material_lot_checks OWNER TO cerp_app;
ALTER TABLE public.of_material_receipt_transfers OWNER TO cerp_app;
COMMIT;
