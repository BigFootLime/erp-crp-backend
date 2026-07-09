-- ROLLBACK for db/patches/20260708_gpao_gammes_operations_types.sql
BEGIN;
ALTER TABLE public.pieces_techniques_operations
  DROP CONSTRAINT IF EXISTS pieces_techniques_operations_type_operation_check,
  DROP COLUMN IF EXISTS type_operation,
  DROP COLUMN IF EXISTS poste_id,
  DROP COLUMN IF EXISTS consignes;
ALTER TABLE public.gammes DROP CONSTRAINT IF EXISTS gammes_statut_check;
ALTER TABLE public.gammes
  ADD CONSTRAINT gammes_statut_check CHECK (statut IN ('BROUILLON','APPLICABLE','OBSOLETE'));
ALTER TABLE public.gammes DROP COLUMN IF EXISTS nom, DROP COLUMN IF EXISTS commentaire;
COMMIT;
