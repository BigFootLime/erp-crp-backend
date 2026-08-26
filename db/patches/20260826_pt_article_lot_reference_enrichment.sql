-- PT quality/criticality and authoritative article/lot reference enrichment.
-- Additive and idempotent: historical rows remain readable and no data is removed.
BEGIN;

ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS quality_levels TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS piece_critique BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS pieces_techniques_piece_critique_idx
  ON public.pieces_techniques (piece_critique)
  WHERE deleted_at IS NULL;

-- OLD/NEW is a provenance of a physical lot, not a client-side calculation.
ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS stock_scope TEXT NOT NULL DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS mp_reference TEXT NULL,
  ADD COLUMN IF NOT EXISTS tr_reference TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lots_stock_scope_check' AND conrelid = 'public.lots'::regclass
  ) THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_stock_scope_check CHECK (stock_scope IN ('OLD', 'NEW'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS lots_article_scope_fifo_idx
  ON public.lots (article_id, stock_scope, received_at NULLS LAST, created_at, id);

-- Stable, explicit business category ordering.  The endpoint keeps historical
-- achat_transforme readable but does not advertise it as selectable.
CREATE TABLE IF NOT EXISTS public.article_category_referential (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  code_segment TEXT NOT NULL,
  stock_managed_default BOOLEAN NOT NULL,
  piece_technique_required BOOLEAN NOT NULL,
  commande_client_selectable BOOLEAN NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL
);

INSERT INTO public.article_category_referential
  (code, label, code_segment, stock_managed_default, piece_technique_required, commande_client_selectable, is_active, sort_order)
VALUES
  ('piece_finie_fabriquee', 'Pièce finie / Fabriquée', 'PLAN', true, true, true, true, 10),
  ('matiere_premiere', 'Matière Première', 'MP', true, false, false, true, 20),
  ('traitement_surface', 'Traitement de Surface', 'TRT', false, false, false, true, 30),
  ('achat_revente', 'Achat-Revente', 'ACH', true, false, false, true, 40),
  ('sous_traitance', 'Sous-traitance', 'STA', false, false, false, true, 50),
  ('achat_transforme', 'Achat-Transformé', 'AHT', true, false, false, false, 90)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  code_segment = EXCLUDED.code_segment,
  stock_managed_default = EXCLUDED.stock_managed_default,
  piece_technique_required = EXCLUDED.piece_technique_required,
  commande_client_selectable = EXCLUDED.commande_client_selectable,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;

-- "Pièce commerce" is an article family/profile and belongs to Achat-Revente.
INSERT INTO public.articles_achat_families (code, designation)
SELECT 'PIECE_COMMERCE', 'Pièce commerce'
WHERE NOT EXISTS (SELECT 1 FROM public.articles_achat_families WHERE code = 'PIECE_COMMERCE');

COMMIT;
