BEGIN TRANSACTION READ ONLY;
DO $$
DECLARE definition text; valid boolean;
BEGIN
  SELECT pg_get_constraintdef(oid),convalidated INTO definition,valid
  FROM pg_constraint
  WHERE conrelid='public.pieces_techniques_operations'::regclass
    AND conname='pieces_techniques_operations_type_operation_check';
  IF definition IS NULL OR position('ASSEMBLAGE' in definition)=0 OR valid IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSEMBLY_OPERATION_CHECK_NOT_VALID';
  END IF;
END $$;
SELECT current_database() AS database_name, 'ASSEMBLY_OPERATION_CHECK_VALID' AS result;
ROLLBACK;
