-- Read-only preflight. No operation, frozen snapshot or inventory is changed.
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database_name,
  pg_get_constraintdef(oid) AS current_constraint
FROM pg_constraint
WHERE conrelid='public.pieces_techniques_operations'::regclass
  AND conname='pieces_techniques_operations_type_operation_check';
SELECT type_operation, COUNT(*) AS operation_count
FROM public.pieces_techniques_operations
GROUP BY type_operation ORDER BY type_operation;
ROLLBACK;
