-- Opening checkpoints are legal/operational evidence. Do not delete them after validation.
SELECT current_database() AS database_name,
       CASE WHEN EXISTS(SELECT 1 FROM public.data_cutover_wip_material_checkpoints)
         THEN 'KEEP_WIP_MATERIAL_OPENING_FACTS_AND_RESTORE_ONLY_COMPATIBLE_APPLICATION_RELEASE'
         ELSE 'NO_WIP_MATERIAL_OPENING_WRITTEN'
       END AS rollback_action;
