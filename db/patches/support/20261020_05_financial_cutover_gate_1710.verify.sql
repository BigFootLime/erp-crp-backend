SELECT current_database() AS database_name,
       singleton,phase,started_at,started_by,started_batch_id,activated_at,activated_by,activation_evidence_reference
FROM public.financial_cutover_gate;
SELECT action,actor_user_id,batch_id,created_at
FROM public.financial_cutover_events
ORDER BY id DESC LIMIT 25;
SELECT EXISTS(
  SELECT 1 FROM pg_trigger
  WHERE tgrelid='public.financial_cutover_events'::regclass
    AND tgname='financial_cutover_events_append_only_1710'
    AND tgenabled='O'
) AS events_append_only_trigger_enabled;
SELECT has_table_privilege('cerp_app','public.financial_cutover_gate','UPDATE') AS gate_update_granted,
       has_table_privilege('cerp_app','public.financial_cutover_events','INSERT') AS events_insert_granted,
       has_table_privilege('cerp_app','public.financial_cutover_events','UPDATE') AS events_update_granted,
       has_table_privilege('cerp_app','public.financial_cutover_events','DELETE') AS events_delete_granted;
