-- A rank belongs to one assembly revision. Legacy rows with a NULL revision
-- form one scope per parent. Install the new protection before removing the
-- historical one. Applying this patch does not update nomenclature rows.
DO $$
DECLARE
  old_definition text;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO old_definition
  FROM pg_constraint
  WHERE conrelid = 'public.pieces_techniques_nomenclature'::regclass
    AND conname = 'ux_ptec_nom_parent_rang';

  IF old_definition IS NOT NULL
    AND old_definition <> 'UNIQUE (parent_piece_technique_id, rang)' THEN
    RAISE EXCEPTION 'Unexpected definition for ux_ptec_nom_parent_rang';
  END IF;
END
$$;

ALTER TABLE public.pieces_techniques_nomenclature
  ADD CONSTRAINT ux_ptec_nom_parent_version_rang
  UNIQUE NULLS NOT DISTINCT (parent_piece_technique_id, parent_piece_technique_version_id, rang);

-- The historical constraint was created outside the patch catalogue on the
-- managed databases. A fresh isolated schema can already lack that constraint.
ALTER TABLE public.pieces_techniques_nomenclature
  DROP CONSTRAINT IF EXISTS ux_ptec_nom_parent_rang;
