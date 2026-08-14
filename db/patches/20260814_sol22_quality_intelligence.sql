-- SOL-22 - Qualite, metrologie et tracabilite mesurables.
-- Additif, rejouable. Aucun indicateur n'est pre-calcule ni simule.

BEGIN;

CREATE TABLE IF NOT EXISTS public.quality_cause_catalog (
  code text PRIMARY KEY,
  label text NOT NULL,
  family text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quality_cause_catalog_code_0450_ck CHECK (code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  CONSTRAINT quality_cause_catalog_family_0450_ck CHECK (
    family IN ('MATERIAL','METHOD','MACHINE','MEASUREMENT','MANPOWER','ENVIRONMENT','SUPPLIER','DESIGN','OTHER')
  )
);

INSERT INTO public.quality_cause_catalog (code, label, family)
VALUES
  ('MATERIAL', 'Matiere', 'MATERIAL'),
  ('METHOD', 'Methode ou gamme', 'METHOD'),
  ('MACHINE', 'Machine ou outillage', 'MACHINE'),
  ('MEASUREMENT', 'Mesure ou moyen de controle', 'MEASUREMENT'),
  ('MANPOWER', 'Organisation ou competence', 'MANPOWER'),
  ('ENVIRONMENT', 'Environnement', 'ENVIRONMENT'),
  ('SUPPLIER', 'Fournisseur', 'SUPPLIER'),
  ('DESIGN', 'Definition technique', 'DESIGN'),
  ('OTHER', 'Autre cause documentee', 'OTHER')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.non_conformity
  ADD COLUMN IF NOT EXISTS cause_code text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'non_conformity_cause_code_0450_fk'
      AND conrelid = 'public.non_conformity'::regclass
  ) THEN
    ALTER TABLE public.non_conformity
      ADD CONSTRAINT non_conformity_cause_code_0450_fk
      FOREIGN KEY (cause_code) REFERENCES public.quality_cause_catalog(code)
      ON UPDATE RESTRICT ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS non_conformity_cause_period_0450_idx
  ON public.non_conformity (cause_code, detection_date)
  WHERE cause_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.quality_cost_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  non_conformity_id uuid NOT NULL
    REFERENCES public.non_conformity(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  category text NOT NULL,
  amount numeric(18, 4) NOT NULL,
  currency text NOT NULL,
  occurred_on date NOT NULL,
  source_type text NOT NULL,
  source_id text NOT NULL,
  evidence_document_id uuid NULL
    REFERENCES public.quality_documents(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  note text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  CONSTRAINT quality_cost_entry_category_0450_ck CHECK (
    category IN ('SCRAP','REWORK','SORTING','CONTAINMENT','RETURN','OTHER')
  ),
  CONSTRAINT quality_cost_entry_amount_0450_ck CHECK (amount > 0),
  CONSTRAINT quality_cost_entry_currency_0450_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT quality_cost_entry_source_0450_ck CHECK (
    source_type IN ('STOCK_MOVEMENT','TIME_ENTRY','SUPPLIER_DOCUMENT','MANUAL_EVIDENCE')
    AND char_length(btrim(source_id)) BETWEEN 1 AND 160
  ),
  CONSTRAINT quality_cost_entry_note_0450_ck CHECK (char_length(btrim(note)) BETWEEN 5 AND 2000),
  CONSTRAINT quality_cost_entry_hash_0450_ck CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT quality_cost_entry_actor_key_0450_uq UNIQUE (created_by, idempotency_key),
  CONSTRAINT quality_cost_entry_source_id_0450_uq UNIQUE (source_type, source_id, category)
);

CREATE INDEX IF NOT EXISTS quality_cost_entry_period_0450_idx
  ON public.quality_cost_entry (occurred_on, category, currency);
CREATE INDEX IF NOT EXISTS quality_cost_entry_nc_0450_idx
  ON public.quality_cost_entry (non_conformity_id, occurred_on DESC);

CREATE OR REPLACE FUNCTION public.quality_cost_entry_guard_0450()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_allowed boolean;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'quality_cost_entry is append-only; record a compensating evidence instead';
  END IF;
  IF NEW.evidence_document_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.quality_documents d
      WHERE d.id = NEW.evidence_document_id
        AND d.removed_at IS NULL
        AND (
          (d.entity_type = 'NON_CONFORMITY' AND d.entity_id = NEW.non_conformity_id)
          OR (
            d.entity_type = 'ACTION'
            AND EXISTS (
              SELECT 1 FROM public.quality_action a
              WHERE a.id = d.entity_id AND a.non_conformity_id = NEW.non_conformity_id
            )
          )
        )
    ) INTO v_allowed;
    IF NOT v_allowed THEN
      RAISE EXCEPTION 'quality cost evidence must belong to the same non-conformity';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_quality_cost_entry_guard_0450 ON public.quality_cost_entry;
CREATE TRIGGER trg_quality_cost_entry_guard_0450
  BEFORE INSERT OR UPDATE OR DELETE ON public.quality_cost_entry
  FOR EACH ROW EXECUTE FUNCTION public.quality_cost_entry_guard_0450();

-- Une politique SPC est versionnee et append-only. Sans ligne ACTIVE, le
-- service declare l'indicateur indisponible au lieu d'inventer une carte.
CREATE TABLE IF NOT EXISTS public.quality_spc_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  version integer NOT NULL,
  characteristic_key text NOT NULL,
  expected_unit text NOT NULL,
  sampling_rule text NOT NULL,
  subgroup_size integer NOT NULL,
  min_subgroups integer NOT NULL,
  cadence_minutes integer NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz NULL,
  active boolean NOT NULL DEFAULT false,
  justification text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer NOT NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  retired_at timestamptz NULL,
  retired_by integer NULL REFERENCES public.users(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  retirement_reason text NULL,
  CONSTRAINT quality_spc_policy_code_version_0450_uq UNIQUE (code, version),
  CONSTRAINT quality_spc_policy_code_0450_ck CHECK (code ~ '^[A-Z][A-Z0-9_-]{2,39}$'),
  CONSTRAINT quality_spc_policy_sampling_0450_ck CHECK (sampling_rule IN ('FIXED','PERCENT','LOT')),
  CONSTRAINT quality_spc_policy_sizes_0450_ck CHECK (
    subgroup_size >= 2 AND min_subgroups >= 2 AND cadence_minutes > 0
  ),
  CONSTRAINT quality_spc_policy_period_0450_ck CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT quality_spc_policy_justification_0450_ck CHECK (char_length(btrim(justification)) >= 10),
  CONSTRAINT quality_spc_policy_retirement_0450_ck CHECK (
    (retired_at IS NULL AND retired_by IS NULL AND retirement_reason IS NULL)
    OR (retired_at IS NOT NULL AND retired_by IS NOT NULL AND char_length(btrim(retirement_reason)) >= 10)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS quality_spc_policy_active_characteristic_0450_uq
  ON public.quality_spc_policy (characteristic_key)
  WHERE active;

CREATE OR REPLACE FUNCTION public.quality_spc_policy_guard_0450()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quality_spc_policy is immutable; retire it before creating a new version';
  END IF;
  IF OLD.active
     AND NOT NEW.active
     AND OLD.effective_to IS NULL
     AND NEW.effective_to IS NOT NULL
     AND NEW.retired_at IS NOT NULL
     AND NEW.retired_by IS NOT NULL
     AND char_length(btrim(NEW.retirement_reason)) >= 10
     AND (to_jsonb(NEW) - ARRAY['active','effective_to','retired_at','retired_by','retirement_reason']::text[])
       = (to_jsonb(OLD) - ARRAY['active','effective_to','retired_at','retired_by','retirement_reason']::text[])
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'quality_spc_policy versions are immutable; only one-way retirement is allowed';
END $$;

DROP TRIGGER IF EXISTS trg_quality_spc_policy_guard_0450 ON public.quality_spc_policy;
CREATE TRIGGER trg_quality_spc_policy_guard_0450
  BEFORE UPDATE OR DELETE ON public.quality_spc_policy
  FOR EACH ROW EXECUTE FUNCTION public.quality_spc_policy_guard_0450();

-- La verification d'une CAPA exige une preuve explicite lorsque le plan la
-- declare obligatoire. Le garde SQL couvre aussi les anciens endpoints.
CREATE OR REPLACE FUNCTION public.quality_action_verification_guard_0450()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'VERIFIED' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.verification_user_id IS NULL OR NEW.verification_date IS NULL THEN
      RAISE EXCEPTION 'verified quality action requires verifier and verification date';
    END IF;
    IF NEW.effectiveness_comment IS NULL OR char_length(btrim(NEW.effectiveness_comment)) < 5 THEN
      RAISE EXCEPTION 'verified quality action requires effectiveness evidence';
    END IF;
    IF NEW.evidence_required AND NOT EXISTS (
      SELECT 1 FROM public.quality_documents d
      WHERE d.entity_type = 'ACTION' AND d.entity_id = NEW.id AND d.removed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'verified quality action requires an active evidence document';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_quality_action_verification_guard_0450 ON public.quality_action;
CREATE TRIGGER trg_quality_action_verification_guard_0450
  BEFORE UPDATE ON public.quality_action
  FOR EACH ROW EXECUTE FUNCTION public.quality_action_verification_guard_0450();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    ALTER TABLE public.quality_cause_catalog OWNER TO cerp_app;
    ALTER TABLE public.quality_cost_entry OWNER TO cerp_app;
    ALTER TABLE public.quality_spc_policy OWNER TO cerp_app;
    GRANT SELECT ON public.quality_cause_catalog TO cerp_app;
    GRANT SELECT, INSERT ON public.quality_cost_entry TO cerp_app;
    GRANT SELECT, INSERT ON public.quality_spc_policy TO cerp_app;
  END IF;
END $$;

COMMENT ON TABLE public.quality_cost_entry IS
  'SOL-22: preuves de cout de non-qualite append-only; aucune absence ne vaut zero.';
COMMENT ON TABLE public.quality_spc_policy IS
  'SOL-22: prerequis SPC versionnes; aucune carte n est calculee sans politique active et observations fiables.';

COMMIT;
