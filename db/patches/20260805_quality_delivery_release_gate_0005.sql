-- GPT56-FEAT-CERP-0005 — Qualité ↔ livraison : décision canonique et pack figé.
-- Aucun contenu de politique n'est semé ici. Une politique métier validée doit
-- être enregistrée et signée explicitement; son absence produit UNKNOWN.

BEGIN;

CREATE TABLE IF NOT EXISTS public.quality_delivery_release_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  rules jsonb NOT NULL,
  rules_sha256 text NOT NULL,
  signature_reference text NULL,
  signed_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  signed_at timestamptz NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  updated_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT quality_delivery_release_policy_code_version_0005_uq UNIQUE (code, version),
  CONSTRAINT quality_delivery_release_policy_version_0005_ck CHECK (version >= 1),
  CONSTRAINT quality_delivery_release_policy_status_0005_ck CHECK (status IN ('DRAFT', 'SIGNED', 'RETIRED')),
  CONSTRAINT quality_delivery_release_policy_rules_0005_ck CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT quality_delivery_release_policy_hash_0005_ck CHECK (rules_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT quality_delivery_release_policy_dates_0005_ck CHECK (valid_to IS NULL OR valid_from <= valid_to),
  CONSTRAINT quality_delivery_release_policy_signature_0005_ck CHECK (
    status = 'DRAFT'
    OR (
      signed_by IS NOT NULL
      AND signed_at IS NOT NULL
      AND signature_reference IS NOT NULL
      AND char_length(btrim(signature_reference)) >= 3
    )
  )
);

-- Une seule version signée peut autoriser les décisions à un instant donné.
-- Le remplacement exige d'abord la retraite explicite de l'ancienne version.
CREATE UNIQUE INDEX IF NOT EXISTS quality_delivery_release_policy_one_signed_0005_uq
  ON public.quality_delivery_release_policy ((status))
  WHERE status = 'SIGNED';

CREATE OR REPLACE FUNCTION public.quality_delivery_release_policy_guard_0005()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status IN ('SIGNED', 'RETIRED') THEN
    RAISE EXCEPTION 'Signed quality delivery policy is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('SIGNED', 'RETIRED') THEN
    IF OLD.status = 'SIGNED'
       AND NEW.status = 'RETIRED'
       AND NEW.id IS NOT DISTINCT FROM OLD.id
       AND NEW.code IS NOT DISTINCT FROM OLD.code
       AND NEW.version IS NOT DISTINCT FROM OLD.version
       AND NEW.rules IS NOT DISTINCT FROM OLD.rules
       AND NEW.rules_sha256 IS NOT DISTINCT FROM OLD.rules_sha256
       AND NEW.signature_reference IS NOT DISTINCT FROM OLD.signature_reference
       AND NEW.signed_by IS NOT DISTINCT FROM OLD.signed_by
       AND NEW.signed_at IS NOT DISTINCT FROM OLD.signed_at
       AND NEW.valid_from IS NOT DISTINCT FROM OLD.valid_from
       AND NEW.valid_to IS NOT DISTINCT FROM OLD.valid_to
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
       AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Signed quality delivery policy is immutable; only SIGNED to RETIRED is allowed'
      USING ERRCODE = '55000';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_quality_delivery_release_policy_guard_0005
  ON public.quality_delivery_release_policy;
CREATE TRIGGER trg_quality_delivery_release_policy_guard_0005
  BEFORE UPDATE OR DELETE ON public.quality_delivery_release_policy
  FOR EACH ROW EXECUTE FUNCTION public.quality_delivery_release_policy_guard_0005();

ALTER TABLE public.bon_livraison_pack_versions
  ADD COLUMN IF NOT EXISTS quality_release_state text NULL,
  ADD COLUMN IF NOT EXISTS quality_release_preview_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS quality_policy_id uuid NULL,
  ADD COLUMN IF NOT EXISTS quality_policy_sha256 text NULL,
  ADD COLUMN IF NOT EXISTS quality_release_snapshot jsonb NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_quality_state_0005_ck'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_quality_state_0005_ck
      CHECK (quality_release_state IS NULL OR quality_release_state IN ('READY', 'DEROGATED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_quality_hash_0005_ck'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_quality_hash_0005_ck
      CHECK (
        (quality_release_preview_sha256 IS NULL AND quality_policy_sha256 IS NULL AND quality_release_snapshot IS NULL)
        OR (
          quality_release_preview_sha256 ~ '^[a-f0-9]{64}$'
          AND quality_policy_sha256 ~ '^[a-f0-9]{64}$'
          AND jsonb_typeof(quality_release_snapshot) = 'object'
          AND quality_policy_id IS NOT NULL
          AND quality_release_state IS NOT NULL
        )
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_quality_policy_0005_fk'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_quality_policy_0005_fk
      FOREIGN KEY (quality_policy_id) REFERENCES public.quality_delivery_release_policy(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS bon_livraison_pack_quality_hash_0005_idx
  ON public.bon_livraison_pack_versions (bon_livraison_id, quality_release_preview_sha256)
  WHERE status = 'GENERATED';

CREATE TABLE IF NOT EXISTS public.bon_livraison_pack_quality_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_version_id uuid NOT NULL
    REFERENCES public.bon_livraison_pack_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  quality_document_id uuid NOT NULL
    REFERENCES public.quality_documents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  document_type text NOT NULL,
  version integer NOT NULL,
  revision text NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bon_livraison_pack_quality_documents_0005_uq UNIQUE (pack_version_id, quality_document_id),
  CONSTRAINT bon_livraison_pack_quality_documents_version_0005_ck CHECK (version >= 1),
  CONSTRAINT bon_livraison_pack_quality_documents_size_0005_ck CHECK (size_bytes >= 0),
  CONSTRAINT bon_livraison_pack_quality_documents_hash_0005_ck CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS bon_livraison_pack_quality_documents_pack_0005_idx
  ON public.bon_livraison_pack_quality_documents (pack_version_id, document_type, id);

CREATE OR REPLACE FUNCTION public.bon_livraison_pack_snapshot_guard_0005()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.bon_livraison_id IS DISTINCT FROM OLD.bon_livraison_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
     OR NEW.generated_by IS DISTINCT FROM OLD.generated_by
     OR NEW.bl_pdf_document_id IS DISTINCT FROM OLD.bl_pdf_document_id
     OR NEW.cofc_pdf_document_id IS DISTINCT FROM OLD.cofc_pdf_document_id
     OR NEW.summary_json IS DISTINCT FROM OLD.summary_json
     OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
     OR NEW.quality_release_state IS DISTINCT FROM OLD.quality_release_state
     OR NEW.quality_release_preview_sha256 IS DISTINCT FROM OLD.quality_release_preview_sha256
     OR NEW.quality_policy_id IS DISTINCT FROM OLD.quality_policy_id
     OR NEW.quality_policy_sha256 IS DISTINCT FROM OLD.quality_policy_sha256
     OR NEW.quality_release_snapshot IS DISTINCT FROM OLD.quality_release_snapshot
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
  THEN
    RAISE EXCEPTION 'Emitted delivery pack snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked delivery pack cannot be restored'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'GENERATED' AND NEW.status NOT IN ('GENERATED', 'REVOKED') THEN
    RAISE EXCEPTION 'Invalid delivery pack status transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bon_livraison_pack_snapshot_guard_0005
  ON public.bon_livraison_pack_versions;
CREATE TRIGGER trg_bon_livraison_pack_snapshot_guard_0005
  BEFORE UPDATE ON public.bon_livraison_pack_versions
  FOR EACH ROW EXECUTE FUNCTION public.bon_livraison_pack_snapshot_guard_0005();

CREATE OR REPLACE FUNCTION public.bon_livraison_pack_quality_documents_append_only_0005()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Delivery pack quality evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_bon_livraison_pack_quality_documents_append_only_0005
  ON public.bon_livraison_pack_quality_documents;
CREATE TRIGGER trg_bon_livraison_pack_quality_documents_append_only_0005
  BEFORE UPDATE OR DELETE ON public.bon_livraison_pack_quality_documents
  FOR EACH ROW EXECUTE FUNCTION public.bon_livraison_pack_quality_documents_append_only_0005();

REVOKE ALL ON public.quality_delivery_release_policy FROM PUBLIC;
REVOKE ALL ON public.bon_livraison_pack_quality_documents FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT ON public.quality_delivery_release_policy TO cerp_app;
    GRANT SELECT, INSERT ON public.bon_livraison_pack_quality_documents TO cerp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cerp_app;
  END IF;
END;
$$;

COMMENT ON TABLE public.quality_delivery_release_policy IS
  'Politique de libération livraison signée. Aucun défaut implicite; les versions signées sont immuables.';
COMMENT ON TABLE public.bon_livraison_pack_quality_documents IS
  'Snapshot append-only des preuves Qualité incluses dans une version de pack émise.';
COMMENT ON COLUMN public.bon_livraison_pack_versions.quality_release_snapshot IS
  'Décision Qualité READY/DEROGATED et preuves figées à l’émission; jamais recalculée dans l’historique.';

COMMIT;
