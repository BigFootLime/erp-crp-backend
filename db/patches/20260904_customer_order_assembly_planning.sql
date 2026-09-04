-- #707 — Articles finis d'assemblage, couverture composants et contrats internes.
-- Additif et rejouable. La commande commerciale continue de référencer l'article ;
-- ces colonnes décrivent uniquement la révision technique qui permet sa fabrication.

BEGIN;

INSERT INTO public.app_feature_flags (key, name, description, enabled, environment)
VALUES (
  'COMMAND_ASSEMBLY_FLOW',
  'Assemblages dans les commandes clients',
  'Active le calcul des composants, les sous-OF partiels et les contrats internes dans le parcours moderne de commande.',
  false,
  'all'
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.piece_technique_versions
  ADD COLUMN IF NOT EXISTS manufacturing_mode text NOT NULL DEFAULT 'SIMPLE',
  ADD COLUMN IF NOT EXISTS assembly_supply_strategy text NOT NULL DEFAULT 'MAKE_TO_ORDER';

UPDATE public.piece_technique_versions version
SET manufacturing_mode = 'ASSEMBLY'
WHERE manufacturing_mode = 'SIMPLE'
  AND EXISTS (
    SELECT 1
    FROM public.pieces_techniques_nomenclature line
    WHERE line.parent_piece_technique_id = version.piece_technique_id
      AND line.parent_piece_technique_version_id = version.id
      AND line.child_piece_technique_id IS NOT NULL
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'piece_technique_versions_manufacturing_mode_ck'
      AND conrelid = 'public.piece_technique_versions'::regclass
  ) THEN
    ALTER TABLE public.piece_technique_versions
      ADD CONSTRAINT piece_technique_versions_manufacturing_mode_ck
      CHECK (manufacturing_mode IN ('SIMPLE', 'ASSEMBLY'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'piece_technique_versions_assembly_supply_strategy_ck'
      AND conrelid = 'public.piece_technique_versions'::regclass
  ) THEN
    ALTER TABLE public.piece_technique_versions
      ADD CONSTRAINT piece_technique_versions_assembly_supply_strategy_ck
      CHECK (assembly_supply_strategy IN ('MAKE_TO_ORDER', 'INTERNAL_CONTRACT'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_assert_piece_version_manufacturing_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  component_count integer;
  fabricated_component_count integer;
BEGIN
  IF NEW.statut <> 'APPLICABLE' THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE line.child_piece_technique_id IS NOT NULL)::integer
    INTO component_count, fabricated_component_count
  FROM public.pieces_techniques_nomenclature line
  WHERE line.parent_piece_technique_id = NEW.piece_technique_id
    AND (line.parent_piece_technique_version_id = NEW.id OR line.parent_piece_technique_version_id IS NULL);

  SELECT component_count + count(*)::integer
    INTO component_count
  FROM public.pieces_techniques_achats purchase
  WHERE purchase.piece_technique_id = NEW.piece_technique_id;

  IF NEW.manufacturing_mode = 'ASSEMBLY' AND component_count = 0 THEN
    RAISE EXCEPTION 'An applicable assembly revision must contain at least one component'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.manufacturing_mode = 'SIMPLE' AND fabricated_component_count > 0 THEN
    RAISE EXCEPTION 'A simple revision cannot contain a fabricated sub-part'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_piece_version_manufacturing_mode
  ON public.piece_technique_versions;
CREATE CONSTRAINT TRIGGER trg_assert_piece_version_manufacturing_mode
AFTER INSERT OR UPDATE OF statut, manufacturing_mode
ON public.piece_technique_versions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.fn_assert_piece_version_manufacturing_mode();

ALTER TABLE public.commande_client
  ADD COLUMN IF NOT EXISTS internal_order_purpose text NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN IF NOT EXISTS internal_contract_source_line_id bigint REFERENCES public.commande_ligne(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS commande_client_internal_contract_source_line_uq
  ON public.commande_client(internal_contract_source_line_id)
  WHERE internal_contract_source_line_id IS NOT NULL
    AND order_type = 'INTERNE'
    AND internal_order_purpose = 'CONTRACT';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'commande_client_internal_order_purpose_ck'
      AND conrelid = 'public.commande_client'::regclass
  ) THEN
    ALTER TABLE public.commande_client
      ADD CONSTRAINT commande_client_internal_order_purpose_ck
      CHECK (
        internal_order_purpose IN ('STANDARD', 'CONTRACT')
        AND (order_type = 'INTERNE' OR internal_order_purpose = 'STANDARD')
      );
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.of_component_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_batch_id uuid NULL REFERENCES public.of_generation_batches(id) ON DELETE RESTRICT,
  consuming_of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  component_of_id bigint NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  parent_piece_technique_id uuid NOT NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  parent_piece_technique_version_id uuid NOT NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  component_kind text NOT NULL,
  component_article_id uuid NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  component_piece_technique_id uuid NULL REFERENCES public.pieces_techniques(id) ON DELETE RESTRICT,
  component_piece_technique_version_id uuid NULL REFERENCES public.piece_technique_versions(id) ON DELETE RESTRICT,
  structure_path text NOT NULL,
  quantity_per_parent numeric(18,6) NOT NULL,
  required_qty numeric(18,6) NOT NULL,
  old_reserved_qty numeric(18,6) NOT NULL DEFAULT 0,
  new_reserved_qty numeric(18,6) NOT NULL DEFAULT 0,
  shortage_qty numeric(18,6) NOT NULL DEFAULT 0,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  purchase_requirement jsonb NULL,
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT of_component_requirements_kind_ck CHECK (component_kind IN ('FABRICATED', 'PURCHASED')),
  CONSTRAINT of_component_requirements_action_ck CHECK (action IN ('RESERVE', 'CREATE_CHILD_OF', 'PURCHASE', 'WAIT_TECHNICAL')),
  CONSTRAINT of_component_requirements_status_ck CHECK (status IN ('OPEN', 'COVERED', 'BLOCKED', 'CANCELLED')),
  CONSTRAINT of_component_requirements_quantities_ck CHECK (
    quantity_per_parent > 0 AND required_qty >= 0 AND old_reserved_qty >= 0
    AND new_reserved_qty >= 0 AND shortage_qty >= 0
    AND old_reserved_qty + new_reserved_qty + shortage_qty <= required_qty + 0.000001
  ),
  CONSTRAINT of_component_requirements_component_ck CHECK (
    (component_kind = 'FABRICATED' AND component_piece_technique_id IS NOT NULL
      AND (component_article_id IS NOT NULL OR action = 'WAIT_TECHNICAL'))
    OR (component_kind = 'PURCHASED' AND component_article_id IS NOT NULL)
  ),
  CONSTRAINT of_component_requirements_batch_path_uq UNIQUE (generation_batch_id, structure_path)
);

CREATE INDEX IF NOT EXISTS of_component_requirements_consuming_idx
  ON public.of_component_requirements(consuming_of_id, status);
CREATE INDEX IF NOT EXISTS of_component_requirements_component_idx
  ON public.of_component_requirements(component_article_id, status);
CREATE INDEX IF NOT EXISTS of_component_requirements_component_of_idx
  ON public.of_component_requirements(component_of_id, status)
  WHERE component_of_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.fn_assert_of_assembly_components_covered()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.statut::text = 'EN_COURS'
     AND OLD.statut::text IS DISTINCT FROM NEW.statut::text
     AND EXISTS (
       SELECT 1
       FROM public.of_component_requirements requirement
       WHERE requirement.consuming_of_id = NEW.id
         AND requirement.status IN ('OPEN', 'BLOCKED')
     )
     AND NOT EXISTS (
       SELECT 1
       FROM public.of_release_decisions decision
       WHERE decision.of_id = NEW.id
         AND decision.decision = 'RELEASED'
         AND decision.override = true
     ) THEN
    RAISE EXCEPTION 'An assembly OF cannot start while component requirements are open'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assert_of_assembly_components_covered
  ON public.ordres_fabrication;
CREATE TRIGGER trg_assert_of_assembly_components_covered
BEFORE UPDATE OF statut
ON public.ordres_fabrication
FOR EACH ROW EXECUTE FUNCTION public.fn_assert_of_assembly_components_covered();

ALTER TABLE public.stock_reservations
  ADD COLUMN IF NOT EXISTS of_component_requirement_id uuid
    REFERENCES public.of_component_requirements(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_active_of_component_batch_uq
  ON public.stock_reservations(of_component_requirement_id, stock_batch_id)
  WHERE status = 'ACTIVE'
    AND of_component_requirement_id IS NOT NULL
    AND stock_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.internal_contract_of_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT,
  commande_ligne_id bigint NOT NULL REFERENCES public.commande_ligne(id) ON DELETE RESTRICT,
  livraison_affaire_id bigint NULL REFERENCES public.affaire(id) ON DELETE RESTRICT,
  quantity numeric(18,6) NOT NULL,
  quantity_received numeric(18,6) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'ALLOCATED',
  created_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_contract_of_allocations_qty_ck CHECK (
    quantity > 0 AND quantity_received >= 0 AND quantity_received <= quantity
  ),
  CONSTRAINT internal_contract_of_allocations_status_ck CHECK (
    status IN ('ALLOCATED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')
  ),
  CONSTRAINT internal_contract_of_allocations_scope_uq UNIQUE (of_id, commande_ligne_id, livraison_affaire_id)
);

CREATE INDEX IF NOT EXISTS internal_contract_of_allocations_of_idx
  ON public.internal_contract_of_allocations(of_id, status);
CREATE INDEX IF NOT EXISTS internal_contract_of_allocations_line_idx
  ON public.internal_contract_of_allocations(commande_ligne_id, status);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.of_component_requirements TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.internal_contract_of_allocations TO cerp_app;
  END IF;
END;
$$;

COMMENT ON COLUMN public.piece_technique_versions.manufacturing_mode IS
  '#707 : SIMPLE ou ASSEMBLY, figé ensuite dans le snapshot technique de l’OF.';
COMMENT ON COLUMN public.piece_technique_versions.assembly_supply_strategy IS
  '#707 : fabrication au besoin ou couverture prioritaire par un contrat interne.';
COMMENT ON TABLE public.of_component_requirements IS
  '#707 : registre de couverture des composants par occurrence technique et OF consommateur.';
COMMENT ON TABLE public.internal_contract_of_allocations IS
  '#707 : allocation bornée d’un OF de contrat interne vers une tranche de commande client.';
COMMENT ON COLUMN public.commande_client.internal_contract_source_line_id IS
  '#707 : ligne client ayant déclenché le brouillon de contrat interne, garante de l’idempotence.';
COMMENT ON COLUMN public.stock_reservations.of_component_requirement_id IS
  '#707 : réservation d’un lot composant pour l’OF consommateur, hors périmètre Atelier BL.';

COMMIT;
