-- Application rollback only. Preserve append-only cutover evidence and links.
-- Never delete these records after a live review or native attachment.
SELECT current_database() AS database_name,
       'KEEP_CUTOVER_OPENING_EVIDENCE_AND_ROLL_BACK_APPLICATION' AS rollback_action;
