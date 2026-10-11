-- Never silently invalidate an operation already used by a route or frozen OF.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE public.pieces_techniques_operations IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.pieces_techniques_operations WHERE type_operation='ASSEMBLAGE') THEN
    RAISE EXCEPTION 'ASSEMBLY_OPERATION_ROLLBACK_REQUIRES_REVIEW';
  END IF;
END $$;
ALTER TABLE public.pieces_techniques_operations
  DROP CONSTRAINT IF EXISTS pieces_techniques_operations_type_operation_check;
ALTER TABLE public.pieces_techniques_operations
  ADD CONSTRAINT pieces_techniques_operations_type_operation_check
  CHECK (type_operation IS NULL OR type_operation IN
    ('TOURNAGE','FRAISAGE','DECOUPE','REPRISE','CONTROLE',
     'LAVAGE','SOUS_TRAITANCE','EMBALLAGE','AUTRE'));
COMMIT;
