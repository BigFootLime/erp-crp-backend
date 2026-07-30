\set ON_ERROR_STOP on

DO $verify$
DECLARE
  invalid_superadmins integer;
  keenan_superadmins integer;
  closed_modules integer;
  overrides_count integer;
BEGIN
  SELECT count(*)::integer
  INTO invalid_superadmins
  FROM public.users
  WHERE COALESCE(is_superadmin, false)
    AND upper(trim(username)) <> 'KEENAN';

  SELECT count(*)::integer
  INTO keenan_superadmins
  FROM public.users
  WHERE upper(trim(username)) = 'KEENAN'
    AND COALESCE(is_superadmin, false);

  SELECT count(*)::integer
  INTO closed_modules
  FROM public.app_modules
  WHERE NOT enabled_by_default OR NOT is_active;

  SELECT count(*)::integer
  INTO overrides_count
  FROM public.app_module_user_access;

  IF invalid_superadmins <> 0 THEN
    RAISE EXCEPTION 'access #262 verify : % superadmin(s) autre(s) que KEENAN', invalid_superadmins;
  END IF;
  IF keenan_superadmins <> 1 THEN
    RAISE EXCEPTION 'access #262 verify : KEENAN superadmin attendu une fois, trouvé %', keenan_superadmins;
  END IF;
  IF closed_modules <> 0 THEN
    RAISE EXCEPTION 'access #262 verify : % module(s) fermé(s) ou inactif(s)', closed_modules;
  END IF;
  IF overrides_count <> 0 THEN
    RAISE EXCEPTION 'access #262 verify : % override(s) résiduel(s)', overrides_count;
  END IF;
END
$verify$;

SELECT
  u.id,
  u.username,
  u.is_superadmin,
  count(m.module_key)::integer AS modules_visibles_par_defaut
FROM public.users AS u
CROSS JOIN public.app_modules AS m
WHERE m.is_active
GROUP BY u.id, u.username, u.is_superadmin
ORDER BY u.username;
