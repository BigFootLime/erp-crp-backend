SELECT
  to_regclass('public.app_roles') IS NOT NULL AS app_roles_exists,
  to_regclass('public.user_role_assignments') IS NOT NULL AS assignments_exists,
  to_regclass('public.user_role_assignment_events') IS NOT NULL AS events_exists,
  (SELECT COUNT(*) FROM public.app_roles WHERE is_active) AS active_roles,
  (
    SELECT COUNT(*)
    FROM public.users u
    LEFT JOIN public.user_role_assignments ura
      ON ura.user_id = u.id
     AND ura.role_key = u.role
    WHERE ura.user_id IS NULL
  ) AS users_missing_primary_assignment;
