SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN ('data_cutover_wip_resumptions','data_cutover_wip_operation_checkpoints') ORDER BY table_name;
SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN ('public.data_cutover_wip_resumptions'::regclass,'public.data_cutover_wip_operation_checkpoints'::regclass)
  AND NOT tgisinternal ORDER BY tgname;
SELECT r.id::text,r.of_id,r.quantity_launched,r.unit,r.material_scope,count(c.id) AS checkpoints
FROM public.data_cutover_wip_resumptions r LEFT JOIN public.data_cutover_wip_operation_checkpoints c ON c.resumption_id=r.id
GROUP BY r.id ORDER BY r.created_at,r.id;
