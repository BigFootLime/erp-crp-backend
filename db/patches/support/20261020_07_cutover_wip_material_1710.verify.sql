SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN (
  'data_cutover_wip_material_checkpoints','data_cutover_wip_material_checkpoint_lines','data_cutover_wip_material_opening_bindings'
) ORDER BY table_name;
SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid IN (
  'public.data_cutover_wip_material_checkpoints'::regclass,
  'public.data_cutover_wip_material_checkpoint_lines'::regclass,
  'public.data_cutover_wip_material_opening_bindings'::regclass
) AND NOT tgisinternal ORDER BY tgname;
SELECT b.of_id,b.of_material_need_id,b.quantity_consumed,b.checkpoint_id
FROM public.data_cutover_wip_material_opening_bindings b ORDER BY b.created_at,b.id;
