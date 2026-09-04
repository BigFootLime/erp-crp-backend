-- #698 — Commande commerciale indépendante de la maturation technique.
-- Additif, rejouable et sans suppression de donnée.

BEGIN;

CREATE TABLE IF NOT EXISTS public.commande_quick_piece_idempotence (
  idempotency_key varchar(160) PRIMARY KEY,
  request_hash char(64) NOT NULL,
  piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.commande_quick_piece_idempotence TO cerp_app;
  END IF;
END;
$$;

ALTER TABLE public.affaire
  ADD COLUMN IF NOT EXISTS parent_affaire_id bigint,
  ADD COLUMN IF NOT EXISTS devis_id bigint REFERENCES public.devis(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS date_ouverture date,
  ADD COLUMN IF NOT EXISTS delivery_readiness_state text NOT NULL DEFAULT 'WAITING_STOCK';

ALTER TABLE public.commande_to_affaire
  ADD COLUMN IF NOT EXISTS role text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affaire_parent_affaire_id_fkey'
      AND conrelid = 'public.affaire'::regclass
  ) THEN
    ALTER TABLE public.affaire
      ADD CONSTRAINT affaire_parent_affaire_id_fkey
      FOREIGN KEY (parent_affaire_id) REFERENCES public.affaire(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'affaire_delivery_readiness_state_check'
      AND conrelid = 'public.affaire'::regclass
  ) THEN
    ALTER TABLE public.affaire
      ADD CONSTRAINT affaire_delivery_readiness_state_check
      CHECK (delivery_readiness_state IN (
        'WAITING_TECHNICAL', 'WAITING_STOCK', 'PARTIALLY_AVAILABLE',
        'READY_FOR_BL', 'COMPLETED', 'CANCELLED'
      ));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS affaire_parent_affaire_idx
  ON public.affaire(parent_affaire_id)
  WHERE parent_affaire_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS affaire_delivery_readiness_idx
  ON public.affaire(delivery_readiness_state, commande_id)
  WHERE NOT is_principal;

-- Reconstitue la hiérarchie des commandes historiques sans changer l'identité
-- des affaires déjà référencées par les BL, réservations ou OF. Une nouvelle
-- affaire agrégatrice est créée, puis les affaires existantes deviennent ses
-- tranches de livraison.
WITH commandes_sans_principale AS (
  SELECT
    a.commande_id,
    min(a.client_id) AS client_id,
    min(a.devis_id) AS devis_id
  FROM public.affaire a
  WHERE a.commande_id IS NOT NULL
  GROUP BY a.commande_id
  HAVING bool_or(a.is_principal) = false
)
INSERT INTO public.affaire (
  reference, client_id, commande_id, devis_id, type_affaire,
  statut, date_ouverture, is_principal, parent_affaire_id, delivery_readiness_state
)
SELECT
  'AFF-MERE-' || source.commande_id::text,
  source.client_id,
  source.commande_id,
  source.devis_id,
  'livraison',
  'OUVERTE',
  CURRENT_DATE,
  true,
  NULL,
  'WAITING_STOCK'
FROM commandes_sans_principale source
ON CONFLICT DO NOTHING;

INSERT INTO public.commande_to_affaire (commande_id, affaire_id, role)
SELECT principale.commande_id, principale.id, NULL
FROM public.affaire principale
WHERE principale.is_principal
  AND principale.commande_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.commande_to_affaire lien
    WHERE lien.commande_id = principale.commande_id
      AND lien.affaire_id = principale.id
  );

UPDATE public.affaire tranche
SET parent_affaire_id = principale.id,
    updated_at = now()
FROM public.affaire principale
WHERE principale.is_principal
  AND principale.commande_id = tranche.commande_id
  AND NOT tranche.is_principal
  AND tranche.parent_affaire_id IS NULL;

-- Les tranches historiques possédant encore une réservation exploitable sont
-- immédiatement visibles dans Atelier BL après migration. Les autres restent
-- en attente, sans inventer une disponibilité logistique.
UPDATE public.affaire target
SET delivery_readiness_state = 'READY_FOR_BL', updated_at = now()
WHERE NOT target.is_principal
  AND EXISTS (
    SELECT 1
    FROM public.stock_reservations reservation
    WHERE reservation.livraison_affaire_id = target.id
      AND reservation.status = 'ACTIVE'
      AND reservation.qty_reserved > reservation.qty_consumed + reservation.qty_prepared
  );

ALTER TABLE public.ordres_fabrication
  ADD COLUMN IF NOT EXISTS technical_readiness text NOT NULL DEFAULT 'INCOMPLETE',
  ADD COLUMN IF NOT EXISTS technical_preparation jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS technical_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS technical_submitted_by integer,
  ADD COLUMN IF NOT EXISTS technical_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS technical_validated_by integer;

CREATE INDEX IF NOT EXISTS ordres_fabrication_technical_queue_idx
  ON public.ordres_fabrication(technical_readiness, statut, date_fin_prevue);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_technical_readiness_check'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_technical_readiness_check
      CHECK (technical_readiness IN ('INCOMPLETE', 'READY_FOR_REVIEW', 'VALIDATED', 'BLOCKED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_technical_submitted_by_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_technical_submitted_by_fkey
      FOREIGN KEY (technical_submitted_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ordres_fabrication_technical_validated_by_fkey'
      AND conrelid = 'public.ordres_fabrication'::regclass
  ) THEN
    ALTER TABLE public.ordres_fabrication
      ADD CONSTRAINT ordres_fabrication_technical_validated_by_fkey
      FOREIGN KEY (technical_validated_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END;
$$;

UPDATE public.ordres_fabrication
SET technical_readiness = CASE
  WHEN technical_snapshot IS NOT NULL AND technical_snapshot_sha256 IS NOT NULL THEN 'VALIDATED'
  WHEN statut::text = 'BROUILLON' THEN 'INCOMPLETE'
  ELSE 'BLOCKED'
END
WHERE technical_readiness = 'INCOMPLETE';

-- Un OF brouillon peut exister sans snapshot. Le snapshot reste « tout ou rien »
-- et ne peut être attaché qu'une seule fois ; toute modification ultérieure est refusée.
CREATE OR REPLACE FUNCTION public.fn_prevent_of_technical_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_was_empty boolean;
  v_is_complete boolean;
BEGIN
  v_was_empty := OLD.piece_technique_version_id IS NULL
    AND OLD.technical_snapshot IS NULL
    AND OLD.technical_snapshot_sha256 IS NULL
    AND OLD.technical_snapshot_at IS NULL;
  v_is_complete := NEW.piece_technique_version_id IS NOT NULL
    AND NEW.technical_snapshot IS NOT NULL
    AND NEW.technical_snapshot_sha256 IS NOT NULL
    AND NEW.technical_snapshot_at IS NOT NULL;

  IF NEW.piece_technique_version_id IS DISTINCT FROM OLD.piece_technique_version_id
     OR NEW.technical_snapshot IS DISTINCT FROM OLD.technical_snapshot
     OR NEW.technical_snapshot_sha256 IS DISTINCT FROM OLD.technical_snapshot_sha256
     OR NEW.technical_snapshot_at IS DISTINCT FROM OLD.technical_snapshot_at THEN
    IF NOT (v_was_empty AND v_is_complete AND OLD.statut::text = 'BROUILLON') THEN
      RAISE EXCEPTION 'OF technical snapshot is immutable after attachment'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_assert_of_technical_snapshot_coherence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_snapshot jsonb;
  v_version_id uuid;
  v_sha256 text;
  v_empty boolean;
  v_complete boolean;
BEGIN
  v_empty := NEW.piece_technique_version_id IS NULL
    AND NEW.technical_snapshot IS NULL
    AND NEW.technical_snapshot_sha256 IS NULL
    AND NEW.technical_snapshot_at IS NULL;
  v_complete := NEW.piece_technique_version_id IS NOT NULL
    AND NEW.technical_snapshot IS NOT NULL
    AND NEW.technical_snapshot_sha256 IS NOT NULL
    AND NEW.technical_snapshot_at IS NOT NULL;

  IF v_empty AND NEW.statut::text = 'BROUILLON' THEN
    RETURN NULL;
  END IF;
  IF NOT v_complete THEN
    RAISE EXCEPTION 'OF technical snapshot fields must be all empty or all populated'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.statut::text <> 'BROUILLON' AND NEW.technical_readiness <> 'VALIDATED' THEN
    RAISE EXCEPTION 'An OF cannot leave BROUILLON before technical validation'
      USING ERRCODE = '23514';
  END IF;

  SELECT s.snapshot, s.piece_technique_version_id, s.snapshot_sha256
    INTO v_snapshot, v_version_id, v_sha256
    FROM public.of_technical_snapshots s
   WHERE s.of_id = NEW.id;
  IF NOT FOUND
     OR v_version_id IS DISTINCT FROM NEW.piece_technique_version_id
     OR v_snapshot IS DISTINCT FROM NEW.technical_snapshot
     OR v_sha256 IS DISTINCT FROM NEW.technical_snapshot_sha256 THEN
    RAISE EXCEPTION 'OF technical snapshot companion is missing or inconsistent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON COLUMN public.affaire.parent_affaire_id IS
  '#698 : tranche de livraison enfant de l’affaire principale de la commande.';
COMMENT ON COLUMN public.affaire.delivery_readiness_state IS
  '#698 : disponibilité logistique calculée ; seul READY_FOR_BL est préparatoire au BL.';
COMMENT ON COLUMN public.ordres_fabrication.technical_readiness IS
  '#698 : maturation technique indépendante du statut opérationnel de l’OF.';
COMMENT ON COLUMN public.ordres_fabrication.technical_preparation IS
  '#698 : sections techniques partielles et preuves, éditables uniquement tant que l’OF est brouillon.';

COMMIT;
