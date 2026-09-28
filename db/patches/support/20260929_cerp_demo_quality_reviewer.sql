BEGIN;
DO $$ BEGIN IF current_database()<>'cerp_demo' THEN RAISE EXCEPTION 'Demo database required'; END IF; END $$;
INSERT INTO app_roles(role_key,category,description,is_active) VALUES('Responsable Qualité','PRIMARY','Contrôleur qualité du scénario synthétique',true) ON CONFLICT(role_key) DO NOTHING;
INSERT INTO users(username,password,name,surname,email,role,status,is_superadmin)
 SELECT username||'_QUALITE',password,'Contrôleur','Démo','demo.qualite@example.test','Responsable Qualité','Active',false FROM users WHERE username='DEMO'
 ON CONFLICT(username) DO NOTHING;
INSERT INTO user_role_assignments(user_id,role_key) SELECT id,'Responsable Qualité' FROM users WHERE username='DEMO_QUALITE' ON CONFLICT(user_id,role_key) DO NOTHING;
COMMIT;
