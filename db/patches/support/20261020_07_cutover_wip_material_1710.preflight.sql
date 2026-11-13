SELECT current_database() AS database_name,
       to_regclass('public.data_cutover_wip_resumptions') IS NOT NULL AS wip_resume_present,
       to_regclass('public.of_material_needs') IS NOT NULL AS material_needs_present,
       to_regclass('public.lots') IS NOT NULL AS lots_present;
SELECT table_name FROM information_schema.tables
WHERE table_schema='public' AND table_name IN (
  'data_cutover_wip_material_checkpoints','data_cutover_wip_material_checkpoint_lines','data_cutover_wip_material_opening_bindings'
) ORDER BY table_name;
