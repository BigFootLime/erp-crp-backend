-- MEGA-QUALITE-BL-01 / #437 -- liberation qualite complete des BL.
-- Ce patch ne cree aucune politique, aucun verdict et aucune signature.

BEGIN;

/* Politique globale, versionnee et auditee. */
ALTER TABLE public.quality_delivery_release_policy
  ADD COLUMN IF NOT EXISTS label text NULL,
  ADD COLUMN IF NOT EXISTS justification text NULL,
  ADD COLUMN IF NOT EXISTS document_reference text NULL,
  ADD COLUMN IF NOT EXISTS submitted_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS submitted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS activated_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS superseded_by_policy_id uuid NULL
    REFERENCES public.quality_delivery_release_policy(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revoked_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS revocation_reason text NULL;

UPDATE public.quality_delivery_release_policy
SET status = CASE status WHEN 'RETIRED' THEN 'SUPERSEDED' ELSE status END,
    label = COALESCE(label, code)
WHERE status = 'RETIRED' OR label IS NULL;

ALTER TABLE public.quality_delivery_release_policy
  ALTER COLUMN label SET NOT NULL;

DROP INDEX IF EXISTS public.quality_delivery_release_policy_one_signed_0005_uq;
ALTER TABLE public.quality_delivery_release_policy
  DROP CONSTRAINT IF EXISTS quality_delivery_release_policy_status_0005_ck,
  DROP CONSTRAINT IF EXISTS quality_delivery_release_policy_signature_0005_ck;

ALTER TABLE public.quality_delivery_release_policy
  ADD CONSTRAINT quality_delivery_release_policy_status_0437_ck
    CHECK (status IN ('DRAFT', 'IN_REVIEW', 'SIGNED', 'ACTIVE', 'SUPERSEDED', 'REVOKED')),
  ADD CONSTRAINT quality_delivery_release_policy_signature_0437_ck
    CHECK (
      status IN ('DRAFT', 'IN_REVIEW')
      OR (
        signed_by IS NOT NULL
        AND signed_at IS NOT NULL
        AND signature_reference IS NOT NULL
        AND char_length(btrim(signature_reference)) >= 3
        AND document_reference IS NOT NULL
        AND char_length(btrim(document_reference)) >= 3
      )
    ),
  ADD CONSTRAINT quality_delivery_release_policy_revocation_0437_ck
    CHECK (
      status <> 'REVOKED'
      OR (
        revoked_by IS NOT NULL
        AND revoked_at IS NOT NULL
        AND revocation_reason IS NOT NULL
        AND char_length(btrim(revocation_reason)) >= 10
      )
    );

CREATE UNIQUE INDEX quality_delivery_release_policy_one_active_0437_uq
  ON public.quality_delivery_release_policy ((status))
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS public.quality_delivery_release_policy_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES public.quality_delivery_release_policy(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_status text NULL,
  to_status text NULL,
  reason text NULL,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  actor_user_id integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_delivery_release_policy_event_type_0437_ck
    CHECK (event_type IN ('CREATED', 'UPDATED', 'SUBMITTED', 'SIGNED', 'ACTIVATED', 'SUPERSEDED', 'REVOKED')),
  CONSTRAINT quality_delivery_release_policy_event_hash_0437_ck
    CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT quality_delivery_release_policy_event_snapshot_0437_ck
    CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS quality_delivery_release_policy_event_policy_0437_idx
  ON public.quality_delivery_release_policy_event (policy_id, created_at, id);

CREATE OR REPLACE FUNCTION public.quality_delivery_release_policy_guard_0005()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'Reviewed quality delivery policy is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IN ('SIGNED', 'ACTIVE', 'SUPERSEDED', 'REVOKED') THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.label IS DISTINCT FROM OLD.label
       OR NEW.rules IS DISTINCT FROM OLD.rules
       OR NEW.rules_sha256 IS DISTINCT FROM OLD.rules_sha256
       OR NEW.signature_reference IS DISTINCT FROM OLD.signature_reference
       OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.document_reference IS DISTINCT FROM OLD.document_reference
       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
    THEN
      RAISE EXCEPTION 'Signed quality delivery policy content is immutable'
        USING ERRCODE = '55000';
    END IF;

    IF NOT (
      (OLD.status = 'SIGNED' AND NEW.status IN ('SIGNED', 'ACTIVE', 'REVOKED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'SUPERSEDED', 'REVOKED'))
      OR (OLD.status = 'SUPERSEDED' AND NEW.status = 'SUPERSEDED')
      OR (OLD.status = 'REVOKED' AND NEW.status = 'REVOKED')
    ) THEN
      RAISE EXCEPTION 'Invalid signed quality delivery policy transition'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.quality_delivery_release_policy_event_append_only_0437()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Quality delivery policy audit is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_quality_delivery_release_policy_event_append_only_0437
  ON public.quality_delivery_release_policy_event;
CREATE TRIGGER trg_quality_delivery_release_policy_event_append_only_0437
  BEFORE UPDATE OR DELETE ON public.quality_delivery_release_policy_event
  FOR EACH ROW EXECUTE FUNCTION public.quality_delivery_release_policy_event_append_only_0437();

/* Un controle LOT_RELEASE designe l'allocation exacte et son BL. */
ALTER TABLE public.quality_control
  ADD COLUMN IF NOT EXISTS delivery_allocation_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_delivery_allocation_0437_fk'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_delivery_allocation_0437_fk
      FOREIGN KEY (delivery_allocation_id)
      REFERENCES public.bon_livraison_ligne_allocations(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quality_control_delivery_release_scope_0437_ck'
      AND conrelid = 'public.quality_control'::regclass
  ) THEN
    ALTER TABLE public.quality_control
      ADD CONSTRAINT quality_control_delivery_release_scope_0437_ck
      CHECK (
        trigger_type <> 'LOT_RELEASE'
        OR (
          source_type = 'LOT'
          AND lot_id IS NOT NULL
          AND bon_livraison_id IS NOT NULL
          AND delivery_allocation_id IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS quality_control_delivery_allocation_0437_idx
  ON public.quality_control (delivery_allocation_id, control_date DESC, id DESC)
  WHERE delivery_allocation_id IS NOT NULL;

/* Dossier canonique fige avant toute emission de pack. */
CREATE TABLE IF NOT EXISTS public.quality_delivery_dossier_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bon_livraison_id uuid NOT NULL REFERENCES public.bon_livraison(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'FROZEN',
  policy_id uuid NOT NULL REFERENCES public.quality_delivery_release_policy(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  policy_sha256 text NOT NULL,
  release_preview_sha256 text NOT NULL,
  dossier_sha256 text NOT NULL,
  release_snapshot jsonb NOT NULL,
  evidence_manifest jsonb NOT NULL,
  freeze_reason text NOT NULL,
  frozen_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  revoked_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  revoked_at timestamptz NULL,
  revocation_reason text NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_delivery_dossier_versions_delivery_version_0437_uq UNIQUE (bon_livraison_id, version),
  CONSTRAINT quality_delivery_dossier_versions_actor_key_0437_uq UNIQUE (frozen_by, idempotency_key),
  CONSTRAINT quality_delivery_dossier_versions_status_0437_ck CHECK (status IN ('FROZEN', 'REVOKED')),
  CONSTRAINT quality_delivery_dossier_versions_hashes_0437_ck CHECK (
    policy_sha256 ~ '^[a-f0-9]{64}$'
    AND release_preview_sha256 ~ '^[a-f0-9]{64}$'
    AND dossier_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT quality_delivery_dossier_versions_json_0437_ck CHECK (
    jsonb_typeof(release_snapshot) = 'object'
    AND jsonb_typeof(evidence_manifest) = 'array'
  ),
  CONSTRAINT quality_delivery_dossier_versions_reason_0437_ck CHECK (char_length(btrim(freeze_reason)) >= 10),
  CONSTRAINT quality_delivery_dossier_versions_revocation_0437_ck CHECK (
    status <> 'REVOKED'
    OR (
      revoked_by IS NOT NULL
      AND revoked_at IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND char_length(btrim(revocation_reason)) >= 10
    )
  )
);

CREATE INDEX IF NOT EXISTS quality_delivery_dossier_versions_current_0437_idx
  ON public.quality_delivery_dossier_versions (bon_livraison_id, version DESC)
  WHERE status = 'FROZEN';

CREATE OR REPLACE FUNCTION public.quality_delivery_dossier_guard_0437()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Quality delivery dossier is append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'REVOKED' OR NEW.status <> 'REVOKED'
     OR NEW.bon_livraison_id IS DISTINCT FROM OLD.bon_livraison_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
     OR NEW.policy_sha256 IS DISTINCT FROM OLD.policy_sha256
     OR NEW.release_preview_sha256 IS DISTINCT FROM OLD.release_preview_sha256
     OR NEW.dossier_sha256 IS DISTINCT FROM OLD.dossier_sha256
     OR NEW.release_snapshot IS DISTINCT FROM OLD.release_snapshot
     OR NEW.evidence_manifest IS DISTINCT FROM OLD.evidence_manifest
     OR NEW.freeze_reason IS DISTINCT FROM OLD.freeze_reason
     OR NEW.frozen_by IS DISTINCT FROM OLD.frozen_by
     OR NEW.frozen_at IS DISTINCT FROM OLD.frozen_at
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Frozen quality delivery dossier is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_quality_delivery_dossier_guard_0437
  ON public.quality_delivery_dossier_versions;
CREATE TRIGGER trg_quality_delivery_dossier_guard_0437
  BEFORE UPDATE OR DELETE ON public.quality_delivery_dossier_versions
  FOR EACH ROW EXECUTE FUNCTION public.quality_delivery_dossier_guard_0437();

ALTER TABLE public.bon_livraison_pack_versions
  ADD COLUMN IF NOT EXISTS quality_dossier_version_id uuid NULL;

CREATE OR REPLACE FUNCTION public.bon_livraison_pack_quality_dossier_guard_0437()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'GENERATED' AND NEW.quality_dossier_version_id IS NULL THEN
    RAISE EXCEPTION 'A generated delivery pack requires a frozen quality dossier'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.quality_dossier_version_id IS DISTINCT FROM OLD.quality_dossier_version_id
  THEN
    RAISE EXCEPTION 'Delivery pack quality dossier link is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bon_livraison_pack_quality_dossier_guard_0437
  ON public.bon_livraison_pack_versions;
CREATE TRIGGER trg_bon_livraison_pack_quality_dossier_guard_0437
  BEFORE INSERT OR UPDATE ON public.bon_livraison_pack_versions
  FOR EACH ROW EXECUTE FUNCTION public.bon_livraison_pack_quality_dossier_guard_0437();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bon_livraison_pack_quality_dossier_0437_fk'
      AND conrelid = 'public.bon_livraison_pack_versions'::regclass
  ) THEN
    ALTER TABLE public.bon_livraison_pack_versions
      ADD CONSTRAINT bon_livraison_pack_quality_dossier_0437_fk
      FOREIGN KEY (quality_dossier_version_id)
      REFERENCES public.quality_delivery_dossier_versions(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.quality_command_receipts
  DROP CONSTRAINT IF EXISTS quality_command_receipts_aggregate_228_ck;
ALTER TABLE public.quality_command_receipts
  ADD CONSTRAINT quality_command_receipts_aggregate_0437_ck
  CHECK (aggregate_type IN (
    'PLAN', 'CONTROL', 'NON_CONFORMITY', 'ACTION', 'DEROGATION',
    'RELEASE', 'DISPOSITION', 'POLICY', 'DOSSIER'
  ));

REVOKE ALL ON public.quality_delivery_release_policy_event FROM PUBLIC;
REVOKE ALL ON public.quality_delivery_dossier_versions FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.quality_delivery_release_policy TO cerp_app;
    GRANT SELECT, INSERT ON public.quality_delivery_release_policy_event TO cerp_app;
    GRANT SELECT, INSERT, UPDATE ON public.quality_delivery_dossier_versions TO cerp_app;
  END IF;
END $$;

COMMENT ON TABLE public.quality_delivery_release_policy_event IS
  'Journal append-only de la politique globale de liberation qualite des BL.';
COMMENT ON COLUMN public.quality_control.delivery_allocation_id IS
  'Allocation exacte du BL couverte par un controle LOT_RELEASE.';
COMMENT ON TABLE public.quality_delivery_dossier_versions IS
  'Versions canoniques et immuables du dossier qualite d un BL, figees avant emission.';

COMMIT;
