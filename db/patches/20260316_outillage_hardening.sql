-- Outillage hardening patch
-- - version legacy gestion_outils schema changes in-repo
-- - add famille image support for deployment-safe taxonomy assets
-- - enrich stock movements with supplier and unit-price metadata
-- - allow inventaire movements in legacy movement check constraint

ALTER TABLE IF EXISTS public.gestion_outils_famille
  ADD COLUMN IF NOT EXISTS image_path text;

ALTER TABLE IF EXISTS public.gestion_outils_mouvement_stock
  ADD COLUMN IF NOT EXISTS id_fournisseur integer,
  ADD COLUMN IF NOT EXISTS prix_unitaire numeric(12, 2);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gestion_outils_mouvement_stock_id_fournisseur_fkey'
      AND conrelid = 'public.gestion_outils_mouvement_stock'::regclass
  ) THEN
    ALTER TABLE public.gestion_outils_mouvement_stock
      DROP CONSTRAINT gestion_outils_mouvement_stock_id_fournisseur_fkey;
  END IF;

  ALTER TABLE public.gestion_outils_mouvement_stock
    ADD CONSTRAINT gestion_outils_mouvement_stock_id_fournisseur_fkey
    FOREIGN KEY (id_fournisseur)
    REFERENCES public.gestion_outils_fournisseur(id_fournisseur)
    ON DELETE SET NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_outils_mvt_prix_unitaire_nonneg'
      AND conrelid = 'public.gestion_outils_mouvement_stock'::regclass
  ) THEN
    ALTER TABLE public.gestion_outils_mouvement_stock
      DROP CONSTRAINT chk_outils_mvt_prix_unitaire_nonneg;
  END IF;

  ALTER TABLE public.gestion_outils_mouvement_stock
    ADD CONSTRAINT chk_outils_mvt_prix_unitaire_nonneg
    CHECK (prix_unitaire IS NULL OR prix_unitaire >= 0);
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_outils_mvt_supplier_price_pair'
      AND conrelid = 'public.gestion_outils_mouvement_stock'::regclass
  ) THEN
    ALTER TABLE public.gestion_outils_mouvement_stock
      DROP CONSTRAINT chk_outils_mvt_supplier_price_pair;
  END IF;

  ALTER TABLE public.gestion_outils_mouvement_stock
    ADD CONSTRAINT chk_outils_mvt_supplier_price_pair
    CHECK (
      (id_fournisseur IS NULL AND prix_unitaire IS NULL)
      OR (id_fournisseur IS NOT NULL AND prix_unitaire IS NOT NULL)
    );
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'gestion_outils_mouvement_stock_type_mouvement_check'
      AND conrelid = 'public.gestion_outils_mouvement_stock'::regclass
  ) THEN
    ALTER TABLE public.gestion_outils_mouvement_stock
      DROP CONSTRAINT gestion_outils_mouvement_stock_type_mouvement_check;
  END IF;

  ALTER TABLE public.gestion_outils_mouvement_stock
    ADD CONSTRAINT gestion_outils_mouvement_stock_type_mouvement_check
    CHECK (
      type_mouvement IS NULL
      OR type_mouvement IN ('entrée', 'sortie', 'inventaire')
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_outils_famille_ordre
  ON public.gestion_outils_famille (ordre NULLS LAST, nom_famille);

CREATE INDEX IF NOT EXISTS idx_outils_geometrie_famille_ordre
  ON public.gestion_outils_geometrie (id_famille, ordre NULLS LAST, nom_geometrie);

CREATE INDEX IF NOT EXISTS idx_outils_historique_prix_outil_date
  ON public.gestion_outils_historique_prix (id_outil, date_prix DESC);

CREATE INDEX IF NOT EXISTS idx_outils_historique_prix_outil_fournisseur_date
  ON public.gestion_outils_historique_prix (id_outil, id_fournisseur, date_prix DESC);

CREATE INDEX IF NOT EXISTS idx_outils_mvt_outil_date
  ON public.gestion_outils_mouvement_stock (id_outil, date_mouvement DESC);

CREATE INDEX IF NOT EXISTS idx_outils_mvt_fournisseur_date
  ON public.gestion_outils_mouvement_stock (id_fournisseur, date_mouvement DESC)
  WHERE id_fournisseur IS NOT NULL;

COMMENT ON COLUMN public.gestion_outils_famille.image_path IS
  'Relative path under uploads/images for famille illustration assets (for example: outillage/familles/fraise-carbure.png).';

COMMENT ON COLUMN public.gestion_outils_geometrie.image_path IS
  'Relative path under uploads/images for geometrie illustration assets (for example: outillage/geometries/torique.png).';

COMMENT ON COLUMN public.gestion_outils_mouvement_stock.id_fournisseur IS
  'Supplier used for replenishment transactions; null for withdrawals and inventory adjustments.';

COMMENT ON COLUMN public.gestion_outils_mouvement_stock.prix_unitaire IS
  'Unit price paid during replenishment transactions, stored in EUR by convention.';
