-- Issue #446 - Functional stock scopes OLD/NEW and historical opening traceability.
-- Additive and idempotent. OLD is represented by normal, auditable stock entries;
-- it never invents a supplier receipt, sales order or manufacturing order.

BEGIN;

-- The current stock read/write model (#225) uses UUID magasin identifiers.
-- Fail explicitly on an obsolete bootstrap schema instead of failing later on
-- an opaque UUID cast or foreign-key error.
DO $$
DECLARE
  magasin_id_type text;
  emplacement_magasin_id_type text;
BEGIN
  SELECT format_type(attribute.atttypid, attribute.atttypmod)
  INTO magasin_id_type
  FROM pg_attribute attribute
  WHERE attribute.attrelid = 'public.magasins'::regclass
    AND attribute.attname = 'id'
    AND NOT attribute.attisdropped;

  SELECT format_type(attribute.atttypid, attribute.atttypmod)
  INTO emplacement_magasin_id_type
  FROM pg_attribute attribute
  WHERE attribute.attrelid = 'public.emplacements'::regclass
    AND attribute.attname = 'magasin_id'
    AND NOT attribute.attisdropped;

  IF magasin_id_type <> 'uuid' OR emplacement_magasin_id_type <> 'uuid' THEN
    RAISE EXCEPTION
      'Stock OLD/NEW #446 requires UUID magasins.id/emplacements.magasin_id (found % / %)',
      magasin_id_type,
      emplacement_magasin_id_type;
  END IF;
END $$;

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS stock_scope text NOT NULL DEFAULT 'NEW';
ALTER TABLE public.magasins
  ADD COLUMN IF NOT EXISTS stock_scope text NOT NULL DEFAULT 'NEW';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_stock_scope_446_ck') THEN
    ALTER TABLE public.warehouses ADD CONSTRAINT warehouses_stock_scope_446_ck CHECK (stock_scope IN ('OLD', 'NEW'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'magasins_stock_scope_446_ck') THEN
    ALTER TABLE public.magasins ADD CONSTRAINT magasins_stock_scope_446_ck CHECK (stock_scope IN ('OLD', 'NEW'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS warehouses_stock_scope_446_idx ON public.warehouses(stock_scope);
CREATE INDEX IF NOT EXISTS magasins_stock_scope_446_idx ON public.magasins(stock_scope);

-- Stable technical code stays achat_transforme; only its functional label changes.
UPDATE public.article_category_ref
SET label = 'Fourniture Client'
WHERE code = 'achat_transforme';

ALTER TABLE public.articles_achat
  ADD COLUMN IF NOT EXISTS reference_client text NULL,
  ADD COLUMN IF NOT EXISTS indice_client text NULL,
  ADD COLUMN IF NOT EXISTS numero_client text NULL;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS stock_trace_code char(6) NULL,
  ADD COLUMN IF NOT EXISTS qr_payload text NULL,
  ADD COLUMN IF NOT EXISTS origin_stock_scope text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_origin_stock_scope_446_ck') THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_origin_stock_scope_446_ck
      CHECK (origin_stock_scope IS NULL OR origin_stock_scope IN ('OLD', 'NEW'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_stock_trace_code_446_ck') THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_stock_trace_code_446_ck
      CHECK (stock_trace_code IS NULL OR stock_trace_code::text ~ '^[0-9]{6}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_qr_payload_446_ck') THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_qr_payload_446_ck
      CHECK (
        (stock_trace_code IS NULL AND qr_payload IS NULL)
        OR (
          stock_trace_code IS NOT NULL
          AND qr_payload = 'CERP-STOCK:' || stock_trace_code::text
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.lots.origin_stock_scope IS
  'Immutable provenance of the lot opening/import. Current OLD/NEW scope is always derived from its stock position.';

CREATE SEQUENCE IF NOT EXISTS public.stock_trace_code_446_seq MINVALUE 1 MAXVALUE 999999;

CREATE UNIQUE INDEX IF NOT EXISTS lots_stock_trace_code_446_uq
  ON public.lots(stock_trace_code) WHERE stock_trace_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.stock_lot_trace_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES public.lots(id) ON DELETE RESTRICT,
  reference_type text NOT NULL,
  reference_value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT stock_lot_trace_references_type_446_ck
    CHECK (reference_type IN ('OF', 'AFFAIRE', 'MP_LOT', 'TRAITEMENT_LOT')),
  CONSTRAINT stock_lot_trace_references_value_446_ck CHECK (btrim(reference_value) <> ''),
  CONSTRAINT stock_lot_trace_references_446_uq UNIQUE(lot_id, reference_type, reference_value)
);
CREATE INDEX IF NOT EXISTS stock_lot_trace_references_lot_446_idx ON public.stock_lot_trace_references(lot_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT ON public.stock_lot_trace_references TO cerp_app;
    GRANT USAGE, SELECT ON SEQUENCE public.stock_trace_code_446_seq TO cerp_app;
  END IF;
END $$;

-- Four fixed functional stores. HYPERBOX2 keeps both the current (`code`,
-- `name`, `is_active`) and legacy (`code_magasin`, `libelle`, `actif`) magasin
-- fields as NOT NULL. Seed both representations so the historical schema and
-- current stock APIs see the same functional stores.
INSERT INTO public.warehouses (code, name, stock_scope)
VALUES
  ('OLD-PF', 'Base old - Produits finis', 'OLD'),
  ('OLD-MP', 'Base old - Matieres premieres', 'OLD'),
  ('NEW-PF', 'Base new - Produits finis', 'NEW'),
  ('NEW-MP', 'Base new - Matieres premieres', 'NEW')
ON CONFLICT (code) DO UPDATE SET stock_scope = EXCLUDED.stock_scope;

INSERT INTO public.magasins (
  id, code, code_magasin, name, libelle, stock_scope, warehouse_id, is_active, actif
)
SELECT
  gen_random_uuid(), seed.code, seed.code, seed.name, seed.name,
  seed.stock_scope, w.id, true, true
FROM (VALUES
  ('OLD-PF', 'Base old - Produits finis', 'OLD'),
  ('OLD-MP', 'Base old - Matieres premieres', 'OLD'),
  ('NEW-PF', 'Base new - Produits finis', 'NEW'),
  ('NEW-MP', 'Base new - Matieres premieres', 'NEW')
) AS seed(code, name, stock_scope)
JOIN public.warehouses w ON w.code = seed.code
ON CONFLICT (code) DO UPDATE
SET code_magasin = EXCLUDED.code_magasin,
    name = EXCLUDED.name,
    libelle = EXCLUDED.libelle,
    stock_scope = EXCLUDED.stock_scope,
    warehouse_id = EXCLUDED.warehouse_id,
    is_active = true,
    actif = true,
    updated_at = now();

COMMIT;
