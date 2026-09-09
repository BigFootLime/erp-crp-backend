-- Read-only. Run on the isolated rehearsal database first.
SELECT current_database() AS database_name;
SELECT to_regclass('public.production_devices') AS devices,
 to_regclass('public.operator_device_sessions') AS sessions,
 to_regclass('public.planning_events') AS planning,
 to_regclass('public.of_self_inspection_sheets') AS inspection_sheets,
 to_regclass('public.quality_command_receipts') AS quality_receipts;
SELECT to_regclass('public.of_documents') AS official_of_documents,
 to_regclass('public.of_material_needs') AS material_needs,
 to_regclass('public.stock_lot_genealogy_edges') AS lot_genealogy,
 to_regclass('public.piece_version_tool_requirements') AS required_tools,
 to_regclass('public.piece_version_programming_tasks') AS programming_tasks;
SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid='public.production_pointages'::regclass AND contype='x';
SELECT code,counts_operator_time,counts_machine_time,legacy_time_type
 FROM public.production_activity_categories WHERE code='AUTO_MACHINE';
