-- Issue #142 (backend) / #276 (frontend) — Traçabilité industrielle 360.
--
-- Patch ADDITIF et IDEMPOTENT. Aucune donnée existante n'est supprimée,
-- réécrite ni requalifiée. Aucune preuve industrielle n'est détruite.
-- À valider sur cerp_test AVANT toute proposition de production.
--
-- Contenu :
--   1. `of_material_consumptions` : l'enregistrement CANONIQUE et immuable de
--      la consommation matière par OF, seul maillon réellement absent de la
--      chaîne « lot matière consommé → OF/opération → lot fabriqué ».
--   2. Index de traçabilité : suppression des balayages séquentiels sur les
--      chemins réellement empruntés par le moteur de généalogie.
--   3. Durcissement du dossier as-built : empreinte du PDF, périmètre figé,
--      révocation historisée.
--
-- Ce que ce patch NE fait PAS, volontairement :
--   - il ne crée aucune seconde source de vérité (les tables métier restent
--     propriétaires de leurs données) ;
--   - il ne remplit `of_material_consumptions` par AUCUN backfill déduit :
--     rapprocher des codes, des dates ou des quantités serait fabriquer une
--     traçabilité. Les consommations historiques restent lisibles via les
--     réservations consommées et les mouvements déclarant un OF, au niveau de
--     preuve qui est réellement le leur.

BEGIN;

/* -------------------------------------------------------------------------- */
/* 0) Préconditions                                                           */
/* -------------------------------------------------------------------------- */

DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'users',
    'articles',
    'lots',
    'stock_movements',
    'stock_movement_lines',
    'stock_reservations',
    'ordres_fabrication',
    'of_operations',
    'of_output_lots',
    'of_receipts',
    'asbuilt_pack_versions'
  ]
  LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION '#142 prerequisite missing: public.%', required_table;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

-- `unaccent` rend la recherche par code métier insensible aux accents. Son
-- absence n'est pas bloquante : le repository bascule automatiquement sur
-- `lower()` seul.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension unaccent (insufficient_privilege)';
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Consommation matière par OF                                             */
/* -------------------------------------------------------------------------- */

-- Support de la clé étrangère composite : garantit que l'article et le lot
-- déclarés dans la consommation sont EXACTEMENT ceux de la ligne de mouvement.
-- Sans cela, on pourrait enregistrer une consommation cohérente en apparence
-- et fausse en réalité.
-- Non partiel : PostgreSQL refuse un index partiel comme cible de clé
-- étrangère. L'index reste trivialement unique puisqu'il commence par la clé
-- primaire, et il ne coûte qu'un index de plus sur une table déjà indexée.
CREATE UNIQUE INDEX IF NOT EXISTS stock_movement_lines_id_article_lot_uq
  ON public.stock_movement_lines (id, article_id, lot_id);

CREATE TABLE IF NOT EXISTS public.of_material_consumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  of_id bigint NOT NULL,
  of_operation_id uuid NULL,
  article_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  stock_movement_id uuid NOT NULL,
  stock_movement_line_id uuid NOT NULL,
  reservation_id uuid NULL,
  qty numeric(18,3) NOT NULL,
  unit_code text NOT NULL,
  effective_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'POSTED',
  source text NOT NULL DEFAULT 'STOCK_MOVEMENT_POST',
  -- Une consommation comptabilisée ne se corrige pas : elle se COMPENSE.
  compensates_id uuid NULL,
  compensated_by_id uuid NULL,
  correlation_id uuid NULL,
  idempotency_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_qty_ck'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_qty_ck CHECK (qty > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_unit_ck'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_unit_ck
      CHECK (char_length(btrim(unit_code)) BETWEEN 1 AND 16);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_status_ck'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_status_ck
      CHECK (status IN ('POSTED', 'COMPENSATED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_source_ck'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_source_ck
      CHECK (source IN ('STOCK_MOVEMENT_POST', 'RESERVATION_CONSUME', 'COMPENSATION'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_not_self_compensation_ck'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_not_self_compensation_ck
      CHECK (compensates_id IS NULL OR compensates_id <> id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_of_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_of_fk
      FOREIGN KEY (of_id) REFERENCES public.ordres_fabrication(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_operation_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_operation_fk
      FOREIGN KEY (of_operation_id) REFERENCES public.of_operations(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_movement_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_movement_fk
      FOREIGN KEY (stock_movement_id) REFERENCES public.stock_movements(id) ON DELETE RESTRICT;
  END IF;

  -- Cohérence forte : la ligne de mouvement, l'article ET le lot doivent
  -- correspondre. Une consommation ne peut pas déclarer un lot qui n'a pas
  -- réellement bougé.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_line_article_lot_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_line_article_lot_fk
      FOREIGN KEY (stock_movement_line_id, article_id, lot_id)
      REFERENCES public.stock_movement_lines(id, article_id, lot_id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_reservation_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_reservation_fk
      FOREIGN KEY (reservation_id) REFERENCES public.stock_reservations(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_compensates_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_compensates_fk
      FOREIGN KEY (compensates_id) REFERENCES public.of_material_consumptions(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_compensated_by_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_compensated_by_fk
      FOREIGN KEY (compensated_by_id) REFERENCES public.of_material_consumptions(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'of_material_consumptions_created_by_fk'
      AND conrelid = 'public.of_material_consumptions'::regclass
  ) THEN
    ALTER TABLE public.of_material_consumptions
      ADD CONSTRAINT of_material_consumptions_created_by_fk
      FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Idempotence : une ligne de mouvement comptabilisée ne produit qu'UNE
-- consommation. Rejouer la comptabilisation ne duplique pas la preuve.
CREATE UNIQUE INDEX IF NOT EXISTS of_material_consumptions_line_uq
  ON public.of_material_consumptions (stock_movement_line_id);

-- Une consommation ne peut être compensée qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS of_material_consumptions_compensates_uq
  ON public.of_material_consumptions (compensates_id)
  WHERE compensates_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS of_material_consumptions_of_idx
  ON public.of_material_consumptions (of_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS of_material_consumptions_lot_idx
  ON public.of_material_consumptions (lot_id, effective_at DESC);
CREATE INDEX IF NOT EXISTS of_material_consumptions_operation_idx
  ON public.of_material_consumptions (of_operation_id)
  WHERE of_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS of_material_consumptions_movement_idx
  ON public.of_material_consumptions (stock_movement_id);
CREATE INDEX IF NOT EXISTS of_material_consumptions_correlation_idx
  ON public.of_material_consumptions (correlation_id)
  WHERE correlation_id IS NOT NULL;

/**
 * Immuabilité : une consommation comptabilisée est une PREUVE. Le seul
 * changement autorisé est le marquage de sa compensation. On n'efface jamais
 * physiquement une preuve — c'est la règle RGPD/ISO du dépôt : restreindre,
 * pseudonymiser, geler, mais pas supprimer aveuglément une trace industrielle.
 */
CREATE OR REPLACE FUNCTION public.fn_protect_of_material_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'of_material_consumptions is append-only: compensate instead of deleting'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.of_id IS DISTINCT FROM OLD.of_id
     OR NEW.article_id IS DISTINCT FROM OLD.article_id
     OR NEW.lot_id IS DISTINCT FROM OLD.lot_id
     OR NEW.stock_movement_id IS DISTINCT FROM OLD.stock_movement_id
     OR NEW.stock_movement_line_id IS DISTINCT FROM OLD.stock_movement_line_id
     OR NEW.qty IS DISTINCT FROM OLD.qty
     OR NEW.unit_code IS DISTINCT FROM OLD.unit_code
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.compensates_id IS DISTINCT FROM OLD.compensates_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'of_material_consumptions is immutable once posted'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'POSTED' AND NEW.status NOT IN ('POSTED', 'COMPENSATED', 'CANCELLED') THEN
    RAISE EXCEPTION 'invalid of_material_consumptions status transition'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('COMPENSATED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'a compensated or cancelled consumption is final'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_of_material_consumption ON public.of_material_consumptions;
CREATE TRIGGER trg_protect_of_material_consumption
BEFORE UPDATE OR DELETE ON public.of_material_consumptions
FOR EACH ROW EXECUTE FUNCTION public.fn_protect_of_material_consumption();

COMMENT ON TABLE public.of_material_consumptions IS
  'Traçabilité #142 : consommation matière prouvée par OF. Append-only, adossée à une ligne de mouvement comptabilisée. Corrections par compensation uniquement.';

/* -------------------------------------------------------------------------- */
/* 2) Index de traçabilité                                                    */
/* -------------------------------------------------------------------------- */

-- Consommation DÉCLARÉE : mouvements comptabilisés qui référencent un OF par
-- son identifiant textuel. Sans cet index, chaque lecture de chaîne provoque
-- un balayage séquentiel de `stock_movements`.
CREATE INDEX IF NOT EXISTS stock_movements_source_document_idx
  ON public.stock_movements (source_document_type, source_document_id)
  WHERE status = 'POSTED' AND source_document_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS stock_movements_reversal_of_idx
  ON public.stock_movements (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

-- Réservation consommée : preuve alternative de la consommation matière.
CREATE INDEX IF NOT EXISTS stock_reservations_of_consumed_idx
  ON public.stock_reservations (of_id)
  WHERE of_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_reservations_bl_ligne_idx
  ON public.stock_reservations (bon_livraison_ligne_id)
  WHERE bon_livraison_ligne_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS reception_fournisseur_stock_receipts_line_idx
  ON public.reception_fournisseur_stock_receipts (reception_line_id);
CREATE INDEX IF NOT EXISTS reception_fournisseur_stock_receipts_movement_idx
  ON public.reception_fournisseur_stock_receipts (stock_movement_id);

CREATE INDEX IF NOT EXISTS reception_incoming_inspections_line_idx
  ON public.reception_incoming_inspections (reception_line_id);
CREATE INDEX IF NOT EXISTS reception_incoming_measurements_inspection_idx
  ON public.reception_incoming_measurements (inspection_id);

CREATE INDEX IF NOT EXISTS of_operations_of_idx
  ON public.of_operations (of_id, phase);
CREATE INDEX IF NOT EXISTS production_pointages_operation_idx
  ON public.production_pointages (operation_id)
  WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS production_pointages_of_idx
  ON public.production_pointages (of_id, start_ts DESC);

CREATE INDEX IF NOT EXISTS bon_livraison_ligne_bl_idx
  ON public.bon_livraison_ligne (bon_livraison_id, ordre);
CREATE INDEX IF NOT EXISTS bon_livraison_delivery_proofs_bl_idx
  ON public.bon_livraison_delivery_proofs (bon_livraison_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS bon_livraison_commande_idx
  ON public.bon_livraison (commande_id)
  WHERE commande_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bon_livraison_affaire_idx
  ON public.bon_livraison (affaire_id)
  WHERE affaire_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS quality_release_decision_control_idx
  ON public.quality_release_decision (quality_control_id);
CREATE INDEX IF NOT EXISTS quality_action_nc_idx
  ON public.quality_action (non_conformity_id);
CREATE INDEX IF NOT EXISTS quality_derogation_lot_idx
  ON public.quality_derogation (lot_id)
  WHERE lot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quality_derogation_of_idx
  ON public.quality_derogation (of_id)
  WHERE of_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quality_derogation_nc_idx
  ON public.quality_derogation (non_conformity_id)
  WHERE non_conformity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS metrologie_certificats_equipement_date_idx
  ON public.metrologie_certificats (equipement_id, date_etalonnage DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS receptions_fournisseurs_cf_idx
  ON public.receptions_fournisseurs (commande_fournisseur_id)
  WHERE commande_fournisseur_id IS NOT NULL;

-- Recherche universelle par code métier : index fonctionnels sur les codes
-- réellement saisis par l'atelier. `text_pattern_ops` sert les préfixes.
CREATE INDEX IF NOT EXISTS lots_lot_code_lower_idx
  ON public.lots (lower(lot_code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS lots_supplier_lot_code_lower_idx
  ON public.lots (lower(supplier_lot_code) text_pattern_ops)
  WHERE supplier_lot_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS ordres_fabrication_numero_lower_idx
  ON public.ordres_fabrication (lower(numero::text) text_pattern_ops);
CREATE INDEX IF NOT EXISTS articles_code_lower_idx
  ON public.articles (lower(code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS bon_livraison_numero_lower_idx
  ON public.bon_livraison (lower(numero) text_pattern_ops);
CREATE INDEX IF NOT EXISTS receptions_fournisseurs_no_lower_idx
  ON public.receptions_fournisseurs (lower(reception_no) text_pattern_ops);
CREATE INDEX IF NOT EXISTS commande_fournisseur_code_lower_idx
  ON public.commande_fournisseur (lower(code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS commande_client_numero_lower_idx
  ON public.commande_client (lower(numero) text_pattern_ops);
CREATE INDEX IF NOT EXISTS affaire_reference_lower_idx
  ON public.affaire (lower(reference) text_pattern_ops);
CREATE INDEX IF NOT EXISTS non_conformity_reference_lower_idx
  ON public.non_conformity (lower(reference) text_pattern_ops);
CREATE INDEX IF NOT EXISTS quality_derogation_code_lower_idx
  ON public.quality_derogation (lower(code) text_pattern_ops);
CREATE INDEX IF NOT EXISTS metrologie_equipements_code_lower_idx
  ON public.metrologie_equipements (lower(code) text_pattern_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pieces_techniques_code_lower_idx
  ON public.pieces_techniques (lower(code_piece) text_pattern_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS traceability_links_source_lookup_idx
  ON public.traceability_links (source_type, source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS traceability_links_target_lookup_idx
  ON public.traceability_links (target_type, target_id, created_at DESC);

COMMENT ON TABLE public.traceability_links IS
  'Table de liens historique (patch 20260228). AUCUN écrivain applicatif ne l''alimente (audit #142). Lue en niveau de preuve « déclaré » uniquement : ce n''est PAS une source de vérité. Cf. ADR-0028.';

/* -------------------------------------------------------------------------- */
/* 3) Durcissement du dossier as-built                                        */
/* -------------------------------------------------------------------------- */

ALTER TABLE public.asbuilt_pack_versions
  ADD COLUMN IF NOT EXISTS pdf_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS pdf_size_bytes bigint NULL,
  ADD COLUMN IF NOT EXISTS as_of timestamptz NULL,
  ADD COLUMN IF NOT EXISTS scope_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revoked_by integer NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason text NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asbuilt_pack_versions_sha256_ck'
      AND conrelid = 'public.asbuilt_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.asbuilt_pack_versions
      ADD CONSTRAINT asbuilt_pack_versions_sha256_ck
      CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[a-f0-9]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asbuilt_pack_versions_scope_object_ck'
      AND conrelid = 'public.asbuilt_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.asbuilt_pack_versions
      ADD CONSTRAINT asbuilt_pack_versions_scope_object_ck
      CHECK (jsonb_typeof(scope_json) = 'object');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asbuilt_pack_versions_revoked_by_fk'
      AND conrelid = 'public.asbuilt_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.asbuilt_pack_versions
      ADD CONSTRAINT asbuilt_pack_versions_revoked_by_fk
      FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'asbuilt_pack_versions_superseded_by_fk'
      AND conrelid = 'public.asbuilt_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.asbuilt_pack_versions
      ADD CONSTRAINT asbuilt_pack_versions_superseded_by_fk
      FOREIGN KEY (superseded_by_id) REFERENCES public.asbuilt_pack_versions(id) ON DELETE RESTRICT;
  END IF;
END $$;

COMMENT ON COLUMN public.asbuilt_pack_versions.pdf_sha256 IS
  'Empreinte SHA-256 du PDF réellement promu en zone documentaire (#142). Calculée AVANT validation transactionnelle : aucun enregistrement ne pointe un fichier absent.';

/* -------------------------------------------------------------------------- */
/* 4) Droits d''exécution du rôle applicatif                                  */
/* -------------------------------------------------------------------------- */

-- Piège documenté dans le runbook HYPERBOX2 : un objet créé via `sudo -u
-- postgres` appartient à `postgres`, et `cerp_app` reçoit alors un 42501 qui
-- devient un 500 côté API. La table est donc explicitement rendue au rôle
-- applicatif ; elle reste protégée en écriture par son trigger append-only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    EXECUTE 'ALTER TABLE public.of_material_consumptions OWNER TO cerp_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON public.of_material_consumptions TO cerp_app';
  ELSE
    RAISE NOTICE 'Role cerp_app absent: ownership step skipped';
  END IF;
END $$;

COMMIT;
