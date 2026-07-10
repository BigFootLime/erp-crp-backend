-- Seed baseline du feature flag PROJECT_OFFICE — idempotent, sans danger sur toute base.
-- Le flag est créé DÉSACTIVÉ (fail-closed). Aucune activation utilisateur ici.
--   sudo -u postgres psql -d cerp_test -f db/seeds/project-office-flag-baseline.sql
--   sudo -u postgres psql -d cerp_prod -f db/seeds/project-office-flag-baseline.sql
--
-- Activation cerp_test (tous les utilisateurs de test) : db/seeds/project-office-flag-enable-test.sql
-- Activation prod (pilote uniquement) : INSERT ciblé app_feature_flag_users — voir
-- docs/ai/project-office-prod-pilot-report.md (jamais enabled=true global en prod).

INSERT INTO public.app_feature_flags (key, name, description, enabled, environment)
VALUES (
  'PROJECT_OFFICE',
  'Project Office / Pilotage projet',
  'Module pilotage projet ERP : macro-planning, Gantt, Kanban, cahier des charges versionné, décisions, risques, preuves, rapport Bac+5. Désactivé par défaut ; activation par utilisateur via app_feature_flag_users.',
  false,
  'all'
)
ON CONFLICT (key) DO NOTHING;
