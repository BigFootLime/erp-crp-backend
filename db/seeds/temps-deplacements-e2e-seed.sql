-- Seed E2E « Temps & Déplacements » — cerp_test UNIQUEMENT (jamais prod).
-- Idempotent. À exécuter APRÈS déploiement du backend dev sur cerp_test, pour la validation navigateur.
-- Nettoyage : db/seeds/temps-deplacements-e2e-cleanup.sql. Identifiants de TEST (non secrets) :
--   token borne   = 'TEST_TD_TOKEN'      (à saisir dans la page borne)
--   badge uid     = 'TEST_TD_BADGE'      (à « taper » sur la borne)
--   employé user  = 'test_td_emp' / mot de passe applicatif à définir hors seed
--   manager user  = 'test_td_mgr' (rôle Directeur ⇒ privilégié RH)
\set ON_ERROR_STOP on
BEGIN;

-- Utilisateurs de test (contraintes users : rôle/gender/tel/postcode/country valides).
INSERT INTO public.users (username,password,name,surname,email,tel_no,role,gender,address,lane,house_no,postcode,date_of_birth,social_security_number)
SELECT 'test_td_mgr','$2b$10$placeholderplaceholderplaceholderplaceholderphash','Test','Manager','test_td_mgr@example.invalid','+33612345678','Directeur','Male','Atelier','Rue','1','75001',DATE '1980-01-01','TEST-MGR'
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE username='test_td_mgr');
INSERT INTO public.users (username,password,name,surname,email,tel_no,role,gender,address,lane,house_no,postcode,date_of_birth,social_security_number)
SELECT 'test_td_emp','$2b$10$placeholderplaceholderplaceholderplaceholderphash','Test','Salarié','test_td_emp@example.invalid','+33612345679','Employee','Female','Atelier','Rue','2','75001',DATE '1990-01-01','TEST-EMP'
WHERE NOT EXISTS (SELECT 1 FROM public.users WHERE username='test_td_emp');

DO $$
DECLARE v_mgr int; v_emp_user int; v_emp uuid; v_rs uuid;
BEGIN
  SELECT id INTO v_mgr FROM public.users WHERE username='test_td_mgr';
  SELECT id INTO v_emp_user FROM public.users WHERE username='test_td_emp';

  -- Règle 35h de test
  SELECT id INTO v_rs FROM public.hr_time_rule_sets WHERE name='TEST 35h';
  IF v_rs IS NULL THEN
    INSERT INTO public.hr_time_rule_sets (name, weekly_target_minutes, daily_target_minutes, overtime_threshold_1_minutes, overtime_rate_1, overtime_threshold_2_minutes, overtime_rate_2)
      VALUES ('TEST 35h',2100,420,2100,1.25,2580,1.5) RETURNING id INTO v_rs;
  END IF;

  -- Employé de test (matricule TEST_TD_EMP), rattaché au manager de test
  SELECT id INTO v_emp FROM public.hr_employees WHERE matricule='TEST_TD_EMP';
  IF v_emp IS NULL THEN
    INSERT INTO public.hr_employees (user_id, matricule, status, manager_user_id) VALUES (v_emp_user,'TEST_TD_EMP','ACTIVE', v_mgr) RETURNING id INTO v_emp;
  END IF;

  -- Contrat actif H35 lié à la règle
  IF NOT EXISTS (SELECT 1 FROM public.hr_employment_contracts WHERE employee_id=v_emp AND active) THEN
    INSERT INTO public.hr_employment_contracts (employee_id, contract_type, weekly_hours_target, daily_hours_target, start_date, rule_set_id, active)
      VALUES (v_emp,'H35',35,7,'2026-01-01', v_rs, true);
  END IF;

  -- Badge de test (uid haché)
  IF NOT EXISTS (SELECT 1 FROM public.hr_badge_credentials WHERE badge_uid_hash=encode(digest('TEST_TD_BADGE','sha256'),'hex') AND active) THEN
    INSERT INTO public.hr_badge_credentials (employee_id, badge_uid_hash, badge_label, active) VALUES (v_emp, encode(digest('TEST_TD_BADGE','sha256'),'hex'),'Badge test', true);
  END IF;

  -- Borne de test (token haché)
  IF NOT EXISTS (SELECT 1 FROM public.hr_time_clock_devices WHERE device_token_hash=encode(digest('TEST_TD_TOKEN','sha256'),'hex')) THEN
    INSERT INTO public.hr_time_clock_devices (name, location, device_type, device_token_hash, status) VALUES ('Borne test','Atelier','KIOSK', encode(digest('TEST_TD_TOKEN','sha256'),'hex'),'ACTIVE');
  END IF;
END $$;

COMMIT;
SELECT 'seed OK — employé=' || (SELECT matricule FROM public.hr_employees WHERE matricule='TEST_TD_EMP') AS resultat;
