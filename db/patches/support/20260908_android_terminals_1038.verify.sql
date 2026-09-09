BEGIN READ ONLY;
SELECT id,label,machine_id FROM public.production_devices WHERE assignment_mode='FIXED' AND machine_id IS NULL;
SELECT t.id FROM public.cerp_terminals t WHERE t.revoked_at IS NOT NULL AND t.device_token_hash IS NOT NULL;
SELECT site_code,count(*) AS duplicate_count FROM public.cerp_terminal_pins WHERE revoked_at IS NULL GROUP BY site_code,pin_hash HAVING count(*)>1;
SELECT operator_user_id,count(*) FROM public.production_pointages WHERE status='RUNNING' AND activity_code IS DISTINCT FROM 'AUTO_MACHINE' GROUP BY operator_user_id HAVING count(*)>1;
SELECT id FROM public.production_pointages WHERE activity_code='AUTO_MACHINE' AND (machine_id IS NULL OR time_type<>'MACHINE');
SELECT code,counts_operator_time,counts_machine_time FROM public.production_activity_categories WHERE code='AUTO_MACHINE';
ROLLBACK;
