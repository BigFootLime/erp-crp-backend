-- Preserve historical single-machine assignments and frozen operation snapshots.
ALTER TABLE public.pieces_techniques_operations
  ADD COLUMN IF NOT EXISTS machine_ids uuid[],
  ADD COLUMN IF NOT EXISTS gamme_source_operation_id uuid,
  ADD COLUMN IF NOT EXISTS programmation_minutes numeric(10,2)
    CHECK (programmation_minutes BETWEEN 0 AND 600000),
  ADD COLUMN IF NOT EXISTS amelioration_continue text
    CHECK (char_length(amelioration_continue) BETWEEN 1 AND 2000),
  ADD COLUMN IF NOT EXISTS amelioration_id uuid;

CREATE TABLE IF NOT EXISTS public.gamme_improvement_receipts (
  flag_id uuid PRIMARY KEY,
  of_id bigint NOT NULL REFERENCES public.ordres_fabrication(id),
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN
    GRANT SELECT, INSERT ON public.gamme_improvement_receipts TO cerp_app;
  END IF;
END $$;

-- Canonical codes are reused if a company has already configured their rates.
INSERT INTO public.centres_frais (code, designation, type_cf, machine_family_code)
SELECT v.code, v.designation, v.type_cf, v.family
FROM (VALUES
  ('CF-FRAISAGE', 'Fraisage CNC', 'FRAISAGE', 'F'),
  ('CF-FRAISAGE-TRAD', 'Fraisage traditionnel', 'FRAISAGE', 'FTRAD'),
  ('CF-TOURNAGE', 'Tournage CNC', 'TOURNAGE', 'T'),
  ('CF-TOURNAGE-TRAD', 'Tournage traditionnel', 'TOURNAGE', 'TTRAD'),
  ('CF-DECOUPE', 'Découpe', 'DECOUPE', 'DECOUPE'),
  ('CF-MAIN-OEUVRE', 'Main-d’œuvre', 'MAIN_OEUVRE', NULL),
  ('CF-PROGRAMMATION', 'Programmation', 'PROGRAMMATION', NULL)
) AS v(code, designation, type_cf, family)
ON CONFLICT DO NOTHING;
