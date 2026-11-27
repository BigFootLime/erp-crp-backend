SELECT current_database() AS database_name,
       pg_get_constraintdef(oid) AS actor_separation_constraint
FROM pg_constraint
WHERE conrelid = 'public.reference_data_change_sets'::regclass
  AND conname = 'reference_data_change_actor_separation_ck';
