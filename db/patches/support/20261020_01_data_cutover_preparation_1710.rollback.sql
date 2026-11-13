-- Application rollback only: redeploy the preceding compatible application.
-- Keep additive preparation tables, original evidence and audit records.
-- No native business table or sequence was changed by the preparation patch.
-- Never delete preparation evidence or restore the entire production database
-- after new business entries merely to remove this screen.
SELECT current_database() AS database_name,
       'KEEP_PREPARATION_EVIDENCE_AND_ROLL_BACK_APPLICATION' AS rollback_action;
