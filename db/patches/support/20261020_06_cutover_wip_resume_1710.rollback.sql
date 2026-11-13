-- Never delete a reviewed WIP resume: this evidence protects stock and production history.
SELECT current_database() AS database_name,
       CASE WHEN EXISTS(SELECT 1 FROM public.data_cutover_wip_resumptions)
            THEN 'KEEP_WIP_RESUMPTIONS_AND_RESTORE_ONLY_COMPATIBLE_APPLICATION_RELEASE'
            ELSE 'NO_WIP_RESUMPTION_WRITTEN'
       END AS rollback_action;
