-- #770 / NAV-PERSONAL-20260908. Personal UI configuration, independently in each database.
BEGIN;
CREATE TABLE IF NOT EXISTS public.user_navigation_preferences (
  user_id integer PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT user_navigation_preferences_object_ck CHECK (jsonb_typeof(preferences) = 'object'),
  CONSTRAINT user_navigation_preferences_version_ck CHECK (preferences->>'schemaVersion' IS NOT NULL AND preferences->>'schemaVersion' = '1'),
  CONSTRAINT user_navigation_preferences_size_ck CHECK (octet_length(preferences::text) <= 131072)
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.user_navigation_preferences TO cerp_app;
  END IF;
END $$;
COMMENT ON TABLE public.user_navigation_preferences IS 'Per-account navigation layout. No permissions or credentials. Last successful save wins.';
COMMIT;
