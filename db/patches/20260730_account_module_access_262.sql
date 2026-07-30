-- Autorisation CERP pilotée uniquement par compte et par module (#262 / frontend #422).
--
-- Etat cible :
--   * tous les modules actifs et ouverts par défaut ;
--   * aucune restriction historique au moment du basculement ;
--   * seules les futures lignes DENIED ferment un module pour un compte ;
--   * KEENAN est l'unique superadministrateur de la Tour de contrôle.
--
-- Les rôles métier restent des données descriptives et d'affectation. Ils ne
-- décident plus de la visibilité ni des capacités d'action dans un module.
--
-- Préflight : db/patches/support/20260730_account_module_access_262.preflight.sql
-- Verify    : db/patches/support/20260730_account_module_access_262.verify.sql

BEGIN;

DO $guard$
DECLARE
  keenan_count integer;
BEGIN
  IF to_regclass('public.users') IS NULL
     OR to_regclass('public.app_modules') IS NULL
     OR to_regclass('public.app_module_user_access') IS NULL
     OR to_regclass('public.app_module_access_events') IS NULL THEN
    RAISE EXCEPTION 'access #262 : infrastructure de contrôle des accès incomplète';
  END IF;

  SELECT count(*)::integer
  INTO keenan_count
  FROM public.users
  WHERE upper(trim(username)) = 'KEENAN';

  IF keenan_count <> 1 THEN
    RAISE EXCEPTION
      'access #262 : exactement un compte KEENAN attendu, trouvé %',
      keenan_count;
  END IF;
END
$guard$;

-- Le privilège de redistribution des accès appartient à un compte unique.
UPDATE public.users
SET is_superadmin = (upper(trim(username)) = 'KEENAN')
WHERE is_superadmin IS DISTINCT FROM (upper(trim(username)) = 'KEENAN');

-- Le défaut global n'est plus une décision d'exploitation : le catalogue est
-- toujours actif et ouvert. La fermeture se fait exclusivement par compte.
UPDATE public.app_modules
SET enabled_by_default = true,
    is_active = true,
    updated_at = now()
WHERE enabled_by_default IS DISTINCT FROM true
   OR is_active IS DISTINCT FROM true;

-- Conserver une preuve append-only avant de remettre tous les comptes à zéro.
INSERT INTO public.app_module_access_events (
  user_id,
  module_key,
  event_type,
  previous_state,
  next_state,
  actor_user_id,
  source
)
SELECT
  access.user_id,
  access.module_key,
  'UNLOCK_ALL',
  access.access,
  'INHERIT',
  keenan.id,
  'migration_262_account_default_allow'
FROM public.app_module_user_access AS access
CROSS JOIN LATERAL (
  SELECT id
  FROM public.users
  WHERE upper(trim(username)) = 'KEENAN'
  LIMIT 1
) AS keenan;

DELETE FROM public.app_module_user_access;

COMMIT;
