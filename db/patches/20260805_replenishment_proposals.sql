-- FEAT-CERP-0003 -- Explainable, human-validated replenishment proposals.
-- Additive and idempotent. This patch never creates, approves or sends a purchase order.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.stock_levels') IS NULL
     OR to_regclass('public.articles') IS NULL
     OR to_regclass('public.fournisseur_catalogue') IS NULL
     OR to_regclass('public.commande_fournisseur') IS NULL
     OR to_regclass('public.commande_fournisseur_ligne') IS NULL THEN
    RAISE EXCEPTION 'FEAT-CERP-0003 prerequisites are missing';
  END IF;
END $$;

ALTER TABLE public.stock_levels
  ADD COLUMN IF NOT EXISTS safety_stock_qty numeric(18,3),
  ADD COLUMN IF NOT EXISTS target_stock_qty numeric(18,3),
  ADD COLUMN IF NOT EXISTS order_lot_size numeric(18,3);

ALTER TABLE public.fournisseur_catalogue
  ADD COLUMN IF NOT EXISTS unite_stock text,
  ADD COLUMN IF NOT EXISTS coef_conversion numeric(18,6),
  ADD COLUMN IF NOT EXISTS lot_achat numeric(18,3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_levels_replenishment_qty_chk') THEN
    ALTER TABLE public.stock_levels ADD CONSTRAINT stock_levels_replenishment_qty_chk CHECK (
      (safety_stock_qty IS NULL OR safety_stock_qty >= 0)
      AND (target_stock_qty IS NULL OR target_stock_qty >= 0)
      AND (order_lot_size IS NULL OR order_lot_size > 0)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fournisseur_catalogue_conversion_chk') THEN
    ALTER TABLE public.fournisseur_catalogue ADD CONSTRAINT fournisseur_catalogue_conversion_chk CHECK (
      (coef_conversion IS NULL OR coef_conversion > 0)
      AND (lot_achat IS NULL OR lot_achat > 0)
      AND ((unite_stock IS NULL AND coef_conversion IS NULL) OR (unite_stock IS NOT NULL AND coef_conversion IS NOT NULL))
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.replenishment_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  magasin_id uuid NOT NULL REFERENCES public.magasins(id) ON DELETE RESTRICT,
  currency text NOT NULL DEFAULT 'EUR',
  period_start date NOT NULL,
  period_end date NOT NULL,
  amount_limit numeric(14,2) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer,
  updated_by integer,
  CONSTRAINT replenishment_budgets_values_chk CHECK (
    period_end >= period_start AND amount_limit >= 0 AND char_length(currency) = 3
  ),
  CONSTRAINT replenishment_budgets_scope_uniq UNIQUE (magasin_id, currency, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS public.replenishment_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_level_id uuid NOT NULL REFERENCES public.stock_levels(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  location_id uuid,
  magasin_id uuid REFERENCES public.magasins(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'PROPOSEE',
  version integer NOT NULL DEFAULT 1,
  reason_code text NOT NULL,
  stock_unit text,
  qty_on_hand numeric(18,3) NOT NULL DEFAULT 0,
  qty_reserved numeric(18,3) NOT NULL DEFAULT 0,
  qty_available numeric(18,3) NOT NULL DEFAULT 0,
  qty_open_orders numeric(18,3) NOT NULL DEFAULT 0,
  minimum_stock_qty numeric(18,3),
  safety_stock_qty numeric(18,3),
  target_stock_qty numeric(18,3),
  net_requirement_qty numeric(18,3) NOT NULL DEFAULT 0,
  selected_catalogue_id uuid REFERENCES public.fournisseur_catalogue(id) ON DELETE SET NULL,
  selected_supplier_id uuid REFERENCES public.fournisseurs(id) ON DELETE SET NULL,
  purchase_unit text,
  stock_units_per_purchase_unit numeric(18,6),
  proposed_purchase_qty numeric(18,3),
  proposed_stock_qty numeric(18,3),
  unit_price numeric(14,4),
  currency text,
  estimated_total numeric(14,2),
  budget_status text NOT NULL DEFAULT 'MISSING',
  budget_remaining numeric(14,2),
  missing_data text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  calculation jsonb NOT NULL DEFAULT '{}'::jsonb,
  commande_fournisseur_id uuid REFERENCES public.commande_fournisseur(id) ON DELETE SET NULL,
  commande_fournisseur_ligne_id uuid REFERENCES public.commande_fournisseur_ligne(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  last_recalculated_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  validated_by integer,
  resolution_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replenishment_proposals_stock_level_uniq UNIQUE (stock_level_id),
  CONSTRAINT replenishment_proposals_status_chk CHECK (status IN ('PROPOSEE','A_COMPLETER','CONVERTIE','RESOLUE')),
  CONSTRAINT replenishment_proposals_budget_chk CHECK (budget_status IN ('OK','EXCEEDED','MISSING','NOT_APPLICABLE')),
  CONSTRAINT replenishment_proposals_values_chk CHECK (
    version > 0 AND qty_on_hand >= 0 AND qty_reserved >= 0 AND qty_available >= 0
    AND qty_open_orders >= 0 AND net_requirement_qty >= 0
    AND (stock_units_per_purchase_unit IS NULL OR stock_units_per_purchase_unit > 0)
    AND (proposed_purchase_qty IS NULL OR proposed_purchase_qty > 0)
    AND (proposed_stock_qty IS NULL OR proposed_stock_qty > 0)
    AND (unit_price IS NULL OR unit_price >= 0)
  )
);

CREATE TABLE IF NOT EXISTS public.replenishment_proposal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.replenishment_proposals(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  calculation jsonb NOT NULL DEFAULT '{}'::jsonb,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.replenishment_proposal_idempotence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id integer NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  proposal_id uuid NOT NULL REFERENCES public.replenishment_proposals(id) ON DELETE RESTRICT,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replenishment_proposal_idem_uniq UNIQUE (actor_id, idempotency_key),
  CONSTRAINT replenishment_proposal_idem_key_chk CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT replenishment_proposal_idem_hash_chk CHECK (request_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE public.commande_fournisseur
  ADD COLUMN IF NOT EXISTS replenishment_proposal_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commande_fournisseur_replenishment_fkey') THEN
    ALTER TABLE public.commande_fournisseur ADD CONSTRAINT commande_fournisseur_replenishment_fkey
      FOREIGN KEY (replenishment_proposal_id) REFERENCES public.replenishment_proposals(id) ON DELETE RESTRICT;
  END IF;
END $$;

DROP INDEX IF EXISTS public.commande_fournisseur_replenishment_uniq;
CREATE INDEX IF NOT EXISTS commande_fournisseur_replenishment_idx
  ON public.commande_fournisseur(replenishment_proposal_id)
  WHERE replenishment_proposal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS replenishment_proposals_status_idx ON public.replenishment_proposals(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS replenishment_proposals_article_site_idx ON public.replenishment_proposals(article_id, magasin_id);
CREATE INDEX IF NOT EXISTS replenishment_proposal_events_proposal_idx ON public.replenishment_proposal_events(proposal_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_replenishment_event_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Replenishment proposal events are append-only' USING ERRCODE = '55000';
END $$;

DROP TRIGGER IF EXISTS replenishment_proposal_events_immutable ON public.replenishment_proposal_events;
CREATE TRIGGER replenishment_proposal_events_immutable
BEFORE UPDATE OR DELETE ON public.replenishment_proposal_events
FOR EACH ROW EXECUTE FUNCTION public.fn_replenishment_event_immutable();

DO $$
BEGIN
  IF to_regproc('public.tg_set_updated_at()') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS replenishment_proposals_set_updated_at ON public.replenishment_proposals';
    EXECUTE 'CREATE TRIGGER replenishment_proposals_set_updated_at BEFORE UPDATE ON public.replenishment_proposals FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
    EXECUTE 'DROP TRIGGER IF EXISTS replenishment_budgets_set_updated_at ON public.replenishment_budgets';
    EXECUTE 'CREATE TRIGGER replenishment_budgets_set_updated_at BEFORE UPDATE ON public.replenishment_budgets FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
  END IF;
END $$;

COMMENT ON TABLE public.replenishment_proposals IS
  'FEAT-CERP-0003 current explainable proposal, unique per stock level (article/site). Validation always recalculates before creating a BCF draft.';
COMMENT ON COLUMN public.fournisseur_catalogue.coef_conversion IS
  'Number of stock units represented by one supplier purchase unit. Required with unite_stock when units differ.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.replenishment_budgets TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.replenishment_proposals TO cerp_app;
    GRANT SELECT, INSERT ON public.replenishment_proposal_events TO cerp_app;
    GRANT SELECT, INSERT ON public.replenishment_proposal_idempotence TO cerp_app;
  END IF;
END $$;

COMMIT;
