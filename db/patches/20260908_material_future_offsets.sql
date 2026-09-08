-- #767: future assignments start after material already received; automatic
-- drafts may be extended only while their complete persisted content is intact.
BEGIN;
ALTER TABLE public.commande_fournisseur_ligne_besoin
  ADD COLUMN IF NOT EXISTS stock_receipt_offset numeric(18,3) CHECK(stock_receipt_offset>=0);
CREATE TABLE IF NOT EXISTS public.of_material_draft_baselines(
  commande_id uuid PRIMARY KEY REFERENCES public.commande_fournisseur(id) ON DELETE RESTRICT,
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{32}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.of_material_draft_baselines OWNER TO cerp_app;
COMMIT;
