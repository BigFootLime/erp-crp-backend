SELECT to_regclass('public.subcontract_operation_completions') IS NOT NULL AS completion_table_present,
  to_regclass('public.production_operation_quantities') IS NOT NULL AS quantities_view_present,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.subcontract_operation_completions'::regclass
    AND tgname='subcontract_completion_1273' AND NOT tgisinternal) AS immutable_evidence_guard,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.production_quantity_declarations'::regclass
    AND tgname='external_local_output_1273' AND NOT tgisinternal) AS double_count_guard;
SELECT count(*) AS completion_count,
  count(*) FILTER(WHERE op.status::text<>'DONE') AS completion_status_mismatch,
  count(*) FILTER(WHERE EXISTS(SELECT 1 FROM public.production_quantity_declarations d WHERE d.operation_id=c.operation_id)) AS local_output_conflicts
FROM public.subcontract_operation_completions c JOIN public.of_operations op ON op.id=c.operation_id;
