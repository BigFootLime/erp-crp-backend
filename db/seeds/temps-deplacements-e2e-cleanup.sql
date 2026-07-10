-- Nettoyage du seed E2E « Temps & Déplacements » — cerp_test UNIQUEMENT.
-- hr_time_events est append-only (triggers) : la purge des événements de test nécessite un superuser
-- via session_replication_role='replica' (comme la rétention CA-SEC-03). À exécuter en tant que postgres.
\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE v_emp uuid;
BEGIN
  SELECT id INTO v_emp FROM public.hr_employees WHERE matricule='TEST_TD_EMP';
  IF v_emp IS NOT NULL THEN
    -- Dérivés (CRUD normaux)
    DELETE FROM public.hr_time_adjustments a USING public.hr_timesheet_days d WHERE a.target_type='DAY' AND a.target_id=d.id AND d.employee_id=v_emp;
    DELETE FROM public.hr_kilometer_entries WHERE employee_id=v_emp;
    DELETE FROM public.hr_timesheet_days WHERE employee_id=v_emp;
    DELETE FROM public.hr_timesheet_weeks WHERE employee_id=v_emp;
    DELETE FROM public.hr_time_anomalies WHERE employee_id=v_emp;
    DELETE FROM public.hr_badge_credentials WHERE employee_id=v_emp;
    -- Événements append-only : purge contrôlée (superuser)
    SET session_replication_role='replica';
    DELETE FROM public.hr_time_events WHERE employee_id=v_emp;
    SET session_replication_role='origin';
    DELETE FROM public.hr_employment_contracts WHERE employee_id=v_emp;
    DELETE FROM public.hr_employees WHERE id=v_emp;
  END IF;
  DELETE FROM public.hr_time_rule_sets WHERE name='TEST 35h';
  DELETE FROM public.hr_time_clock_devices WHERE device_token_hash=encode(digest('TEST_TD_TOKEN','sha256'),'hex');
  DELETE FROM public.hr_payroll_export_batches WHERE exported_by IN (SELECT id FROM public.users WHERE username IN ('test_td_mgr','test_td_emp'));
  DELETE FROM public.users WHERE username IN ('test_td_mgr','test_td_emp');
END $$;
COMMIT;
SELECT count(*) AS restes FROM public.hr_employees WHERE matricule='TEST_TD_EMP';
