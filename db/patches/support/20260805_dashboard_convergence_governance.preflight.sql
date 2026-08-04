\set ON_ERROR_STOP on
SELECT current_database() AS database, current_user AS actor;
SELECT to_regclass('public.app_feature_flags') AS feature_flags,
       to_regclass('public.users') AS users;
