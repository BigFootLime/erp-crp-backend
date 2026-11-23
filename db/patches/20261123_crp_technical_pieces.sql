-- Keep historical pieces untouched. Only expressly CRP pieces own an internal plan reference.
ALTER TABLE public.pieces_techniques
  ADD COLUMN IF NOT EXISTS commercial_scope text,
  ADD COLUMN IF NOT EXISTS crp_plan_reference text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.pieces_techniques'::regclass
      AND conname = 'pieces_techniques_commercial_scope_ck'
  ) THEN
    ALTER TABLE public.pieces_techniques
      ADD CONSTRAINT pieces_techniques_commercial_scope_ck CHECK (
        (commercial_scope IS NULL OR commercial_scope IN ('CLIENTS', 'CRP'))
        AND CASE WHEN commercial_scope = 'CRP' THEN
          crp_plan_reference IS NOT NULL
          AND crp_plan_reference ~ '^[0-9]{6}$'
          AND client_id IS NULL AND code_client IS NULL AND client_name IS NULL
        ELSE crp_plan_reference IS NULL END
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS pieces_techniques_crp_plan_reference_uidx
  ON public.pieces_techniques (crp_plan_reference) WHERE crp_plan_reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.crp_piece_plan_counters (
  year_prefix text PRIMARY KEY CHECK (year_prefix ~ '^[0-9]{2}$'),
  last_value integer NOT NULL CHECK (last_value BETWEEN 1 AND 9999)
);

REVOKE ALL ON public.crp_piece_plan_counters FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.crp_piece_plan_counters TO cerp_app;
  END IF;
END $$;
