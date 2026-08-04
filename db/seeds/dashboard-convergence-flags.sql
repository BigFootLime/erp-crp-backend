-- Baseline idempotente. ON CONFLICT DO NOTHING preserves every later ops decision.
INSERT INTO public.app_feature_flags (key, name, description, enabled, environment)
VALUES
  ('DASHBOARD_ARIANE_DEFAULT', 'ARIANE par défaut', 'OFF rebascule les préférences ARIANE vers V2 tout en préservant les deep links.', true, 'all'),
  ('DASHBOARD_USAGE_METRICS', 'Mesure de convergence dashboard', 'Compteurs journaliers agrégés sans identifiant, rétention 90 jours.', true, 'all')
ON CONFLICT (key) DO NOTHING;
