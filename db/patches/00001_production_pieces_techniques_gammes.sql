-- 00001_production_pieces_techniques_gammes.sql
-- Idempotent migration for the Production module:
-- - Pieces techniques (core + BOM + operations + achats + historique)
-- - Affaire <-> piece technique linking
-- - Piece technique documents (attachments)
-- - Helpful indexes for list filters and audit queries
--
-- Notes:
-- - This script is designed to be safe to run multiple times.
-- - It prefers additive changes (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- - Constraint creation uses catalog checks for idempotency.

/* -------------------------------------------------------------------------- */
/* 0) Optional extensions                                                     */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  -- Commonly used for gen_random_uuid(). If already installed, this is a no-op.
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping extension pgcrypto (insufficient_privilege)';
END $$;

/* -------------------------------------------------------------------------- */
/* 1) Core: pieces_techniques                                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.pieces_techniques (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),

  client_id text NULL,
  created_by integer NULL,
  updated_by integer NULL,

  famille_id uuid NOT NULL,
  name_piece text NOT NULL,
  code_piece text NOT NULL,
  designation text NOT NULL,
  designation_2 text NULL,
  prix_unitaire numeric NOT NULL DEFAULT 0,
  statut text NOT NULL DEFAULT 'DRAFT',
  en_fabrication boolean NOT NULL DEFAULT false,
  cycle integer NULL,
  cycle_fabrication integer NULL,
  code_client text NULL,
  client_name text NULL,
  ensemble boolean NOT NULL DEFAULT false
);

ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS deleted_at timestamp with time zone NULL;

ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS deleted_by integer NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pieces_techniques_prix_unitaire_nonneg'
      AND conrelid = 'public.pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_prix_unitaire_nonneg
      CHECK (prix_unitaire >= 0);
  END IF;
END $$;

DO $$
BEGIN
  -- Allow the status values currently used by the backend module.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pieces_techniques_statut_allowed'
      AND conrelid = 'public.pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_statut_allowed
      CHECK (statut IN ('DRAFT', 'ACTIVE', 'IN_FABRICATION', 'OBSOLETE'));
  END IF;
END $$;

-- List/filter performance indexes
CREATE INDEX IF NOT EXISTS pieces_techniques_client_id_idx ON public.pieces_techniques (client_id);
CREATE INDEX IF NOT EXISTS pieces_techniques_famille_id_idx ON public.pieces_techniques (famille_id);
CREATE INDEX IF NOT EXISTS pieces_techniques_statut_idx ON public.pieces_techniques (statut);
CREATE INDEX IF NOT EXISTS pieces_techniques_updated_at_idx ON public.pieces_techniques (updated_at);
CREATE INDEX IF NOT EXISTS pieces_techniques_deleted_at_idx ON public.pieces_techniques (deleted_at);

-- Enforce uniqueness of code_piece (ERP reference). If already enforced, this is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS pieces_techniques_code_piece_uniq ON public.pieces_techniques (code_piece);

/* -------------------------------------------------------------------------- */
/* 2) BOM: pieces_techniques_nomenclature                                      */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.pieces_techniques_nomenclature (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_piece_technique_id uuid NOT NULL,
  child_piece_technique_id uuid NOT NULL,
  rang integer NOT NULL,
  quantite numeric NOT NULL DEFAULT 1,
  repere text NULL,
  designation text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_nomenclature_parent_fk'
      AND conrelid = 'public.pieces_techniques_nomenclature'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_nomenclature
      ADD CONSTRAINT pt_nomenclature_parent_fk
      FOREIGN KEY (parent_piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_nomenclature_child_fk'
      AND conrelid = 'public.pieces_techniques_nomenclature'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_nomenclature
      ADD CONSTRAINT pt_nomenclature_child_fk
      FOREIGN KEY (child_piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_nomenclature_quantite_nonneg'
      AND conrelid = 'public.pieces_techniques_nomenclature'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_nomenclature
      ADD CONSTRAINT pt_nomenclature_quantite_nonneg
      CHECK (quantite >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_nomenclature_rang_positive'
      AND conrelid = 'public.pieces_techniques_nomenclature'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_nomenclature
      ADD CONSTRAINT pt_nomenclature_rang_positive
      CHECK (rang >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_nomenclature_parent_idx ON public.pieces_techniques_nomenclature (parent_piece_technique_id);
CREATE INDEX IF NOT EXISTS pt_nomenclature_child_idx ON public.pieces_techniques_nomenclature (child_piece_technique_id);
CREATE INDEX IF NOT EXISTS pt_nomenclature_parent_rang_idx ON public.pieces_techniques_nomenclature (parent_piece_technique_id, rang);

/* -------------------------------------------------------------------------- */
/* 3) Operations: pieces_techniques_operations                                 */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.pieces_techniques_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_id uuid NOT NULL,
  cf_id uuid NULL,
  phase integer NOT NULL DEFAULT 10,
  designation text NOT NULL,
  designation_2 text NULL,
  prix numeric NULL,
  coef numeric NOT NULL DEFAULT 1,
  tp numeric NOT NULL DEFAULT 0,
  tf_unit numeric NOT NULL DEFAULT 0,
  qte numeric NOT NULL DEFAULT 1,
  taux_horaire numeric NOT NULL DEFAULT 0,
  temps_total numeric NOT NULL DEFAULT 0,
  cout_mo numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_operations_piece_fk'
      AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_piece_fk
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

DO $$
BEGIN
  -- Optional FK to centres_frais (if table exists). If it doesn't, skip.
  IF to_regclass('public.centres_frais') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_operations_cf_fk'
      AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_cf_fk
      FOREIGN KEY (cf_id) REFERENCES public.centres_frais(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_operations_nonneg'
      AND conrelid = 'public.pieces_techniques_operations'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pt_operations_nonneg
      CHECK (
        coef >= 0 AND tp >= 0 AND tf_unit >= 0 AND qte >= 0 AND taux_horaire >= 0 AND temps_total >= 0 AND cout_mo >= 0
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_operations_piece_idx ON public.pieces_techniques_operations (piece_technique_id);
CREATE INDEX IF NOT EXISTS pt_operations_piece_phase_idx ON public.pieces_techniques_operations (piece_technique_id, phase);

/* -------------------------------------------------------------------------- */
/* 4) Achats: pieces_techniques_achats                                         */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.pieces_techniques_achats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_id uuid NOT NULL,
  phase integer NULL,
  famille_piece_id uuid NULL,
  nom text NULL,
  article_id uuid NULL,
  fournisseur_id uuid NULL,
  fournisseur_nom text NULL,
  fournisseur_code text NULL,
  quantite numeric NOT NULL DEFAULT 1,
  quantite_brut_mm numeric NULL,
  longueur_mm numeric NULL,
  coefficient_chute numeric NULL,
  quantite_pieces numeric NULL,
  prix_par_quantite numeric NULL,
  tarif numeric NULL,
  prix numeric NULL,
  unite_prix text NULL,
  pu_achat numeric NULL,
  tva_achat numeric NULL,
  total_achat_ht numeric NULL,
  total_achat_ttc numeric NULL,
  designation text NULL,
  designation_2 text NULL,
  designation_3 text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_achats_piece_fk'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_piece_fk
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_achats_nonneg'
      AND conrelid = 'public.pieces_techniques_achats'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_achats
      ADD CONSTRAINT pt_achats_nonneg
      CHECK (
        quantite >= 0
        AND COALESCE(quantite_brut_mm, 0) >= 0
        AND COALESCE(longueur_mm, 0) >= 0
        AND COALESCE(coefficient_chute, 0) >= 0
        AND COALESCE(quantite_pieces, 0) >= 0
        AND COALESCE(prix_par_quantite, 0) >= 0
        AND COALESCE(tarif, 0) >= 0
        AND COALESCE(prix, 0) >= 0
        AND COALESCE(pu_achat, 0) >= 0
        AND COALESCE(tva_achat, 0) >= 0
        AND COALESCE(total_achat_ht, 0) >= 0
        AND COALESCE(total_achat_ttc, 0) >= 0
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_achats_piece_idx ON public.pieces_techniques_achats (piece_technique_id);
CREATE INDEX IF NOT EXISTS pt_achats_piece_phase_idx ON public.pieces_techniques_achats (piece_technique_id, phase);

/* -------------------------------------------------------------------------- */
/* 5) Historique (status changes): pieces_techniques_historique                */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.pieces_techniques_historique (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_id uuid NOT NULL,
  date_action timestamp with time zone NOT NULL DEFAULT now(),
  user_id integer NULL,
  ancien_statut text NULL,
  nouveau_statut text NOT NULL,
  commentaire text NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_historique_piece_fk'
      AND conrelid = 'public.pieces_techniques_historique'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_historique
      ADD CONSTRAINT pt_historique_piece_fk
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_historique_piece_date_idx ON public.pieces_techniques_historique (piece_technique_id, date_action DESC);

/* -------------------------------------------------------------------------- */
/* 6) Affaire <-> piece technique association                                  */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.affaire_pieces_techniques (
  affaire_id bigint NOT NULL,
  piece_technique_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'LINKED',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by integer NULL,
  PRIMARY KEY (affaire_id, piece_technique_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'affaire_pieces_techniques_role_allowed'
      AND conrelid = 'public.affaire_pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.affaire_pieces_techniques
      ADD CONSTRAINT affaire_pieces_techniques_role_allowed
      CHECK (role IN ('MAIN', 'LINKED'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.affaire') IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'aff_pt_affaire_fk'
      AND conrelid = 'public.affaire_pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.affaire_pieces_techniques
      ADD CONSTRAINT aff_pt_affaire_fk
      FOREIGN KEY (affaire_id) REFERENCES public.affaire(id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'aff_pt_piece_fk'
      AND conrelid = 'public.affaire_pieces_techniques'::regclass
  ) THEN
    ALTER TABLE public.affaire_pieces_techniques
      ADD CONSTRAINT aff_pt_piece_fk
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS affaire_pieces_techniques_piece_idx ON public.affaire_pieces_techniques (piece_technique_id);
CREATE INDEX IF NOT EXISTS affaire_pieces_techniques_affaire_idx ON public.affaire_pieces_techniques (affaire_id);

-- Only one MAIN piece technique per affaire.
CREATE UNIQUE INDEX IF NOT EXISTS affaire_pieces_techniques_main_uniq
  ON public.affaire_pieces_techniques (affaire_id)
  WHERE role = 'MAIN';

/* -------------------------------------------------------------------------- */
/* 7) Documents: pieces_techniques_documents                                   */
/* -------------------------------------------------------------------------- */

CREATE TABLE IF NOT EXISTS public.pieces_techniques_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  piece_technique_id uuid NOT NULL,
  original_name text NOT NULL,
  stored_name text NOT NULL,
  storage_path text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NULL,
  label text NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  uploaded_by integer NULL,
  removed_at timestamp with time zone NULL,
  removed_by integer NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pt_docs_piece_fk'
      AND conrelid = 'public.pieces_techniques_documents'::regclass
  ) THEN
    ALTER TABLE public.pieces_techniques_documents
      ADD CONSTRAINT pt_docs_piece_fk
      FOREIGN KEY (piece_technique_id) REFERENCES public.pieces_techniques(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pt_docs_piece_idx ON public.pieces_techniques_documents (piece_technique_id);
CREATE INDEX IF NOT EXISTS pt_docs_piece_active_idx ON public.pieces_techniques_documents (piece_technique_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS pt_docs_storage_path_uniq ON public.pieces_techniques_documents (storage_path);

/* -------------------------------------------------------------------------- */
/* 8) Audit logs helpful indexes                                               */
/* -------------------------------------------------------------------------- */

CREATE INDEX IF NOT EXISTS erp_audit_logs_entity_idx
  ON public.erp_audit_logs (entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS erp_audit_logs_user_created_at_idx
  ON public.erp_audit_logs (user_id, created_at DESC);

/* -------------------------------------------------------------------------- */
/* 9) updated_at triggers (optional)                                           */
/* -------------------------------------------------------------------------- */

DO $$
BEGIN
  IF to_regprocedure('public.tg_set_updated_at()') IS NULL THEN
    RAISE NOTICE 'tg_set_updated_at() not found; skipping updated_at triggers.';
    RETURN;
  END IF;

  -- pieces_techniques
  EXECUTE 'DROP TRIGGER IF EXISTS pieces_techniques_set_updated_at ON public.pieces_techniques';
  EXECUTE 'CREATE TRIGGER pieces_techniques_set_updated_at BEFORE UPDATE ON public.pieces_techniques FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  -- nomenclature
  EXECUTE 'DROP TRIGGER IF EXISTS pieces_techniques_nomenclature_set_updated_at ON public.pieces_techniques_nomenclature';
  EXECUTE 'CREATE TRIGGER pieces_techniques_nomenclature_set_updated_at BEFORE UPDATE ON public.pieces_techniques_nomenclature FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  -- operations
  EXECUTE 'DROP TRIGGER IF EXISTS pieces_techniques_operations_set_updated_at ON public.pieces_techniques_operations';
  EXECUTE 'CREATE TRIGGER pieces_techniques_operations_set_updated_at BEFORE UPDATE ON public.pieces_techniques_operations FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  -- achats
  EXECUTE 'DROP TRIGGER IF EXISTS pieces_techniques_achats_set_updated_at ON public.pieces_techniques_achats';
  EXECUTE 'CREATE TRIGGER pieces_techniques_achats_set_updated_at BEFORE UPDATE ON public.pieces_techniques_achats FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';

  -- documents
  EXECUTE 'DROP TRIGGER IF EXISTS pieces_techniques_documents_set_updated_at ON public.pieces_techniques_documents';
  EXECUTE 'CREATE TRIGGER pieces_techniques_documents_set_updated_at BEFORE UPDATE ON public.pieces_techniques_documents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at()';
END $$;
