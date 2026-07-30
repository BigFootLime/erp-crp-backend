-- Réparation ciblée du catalogue de visibilité des modules (#402).
--
-- Contexte : les comptes ordinaires sont filtrés par public.app_modules, alors
-- qu'un superadministrateur le contourne. Des pages réellement livrées étaient
-- absentes ou incomplètes dans le catalogue persistant, donc invisibles pour les
-- utilisateurs non superadmin.
--
-- ADDITIF, IDEMPOTENT, SANS DONNÉE MÉTIER :
--   - sépare Finitions, Centres de frais et Parc machine afin que la Tour
--     d'accès puisse les attribuer individuellement ;
--   - crée ou aligne le module de GED ;
--   - ne modifie jamais ces réglages sur les modules existants ; les nouveaux
--     modules héritent du bloc technique historique à leur première création ;
--   - ne remplace jamais les décisions nominatives existantes.
--
-- Prérequis : 20260727_admin_access_tower_326.sql.
-- Préflight : db/patches/support/20260730_repair_module_catalog_visibility_402.preflight.sql
-- Verify    : db/patches/support/20260730_repair_module_catalog_visibility_402.verify.sql
--
-- Le rollout du pilote Project Office reste une politique distincte, gouvernée
-- par son feature flag et ses contrôles propres : ce patch ne le modifie pas.

BEGIN;

DO $catalog_guard$
BEGIN
  IF to_regclass('public.app_modules') IS NULL THEN
    RAISE EXCEPTION
      'catalogue #402 : public.app_modules absent — appliquer 20260727_admin_access_tower_326.sql d''abord';
  END IF;
END
$catalog_guard$;

-- La pièce technique reste son propre module. Les trois espaces livrés autour
-- d'elle deviennent sélectionnables indépendamment dans la Tour d'accès.
-- On retire seulement les anciens rattachements de navigation/API : les décisions
-- d'exploitation restent dans les colonnes dédiées et dans les overrides ci-dessous.
UPDATE public.app_modules
SET
  label = 'Données techniques',
  description = 'Pièces techniques, versions, gammes et dossiers d’opération.',
  api_prefixes = ARRAY['/pieces-techniques', '/piece-technique-versions', '/gammes', '/dossiers'],
  nav_page_keys = ARRAY['pieces-techniques'],
  sort_order = 100,
  updated_at = now()
WHERE module_key = 'pieces-techniques';

-- A la première application, les nouveaux modules héritent du défaut et de
-- l'activation du bloc technique historique. Cela évite de modifier d'un coup
-- l'accès effectif des comptes. Les réapplications n'écrasent jamais les choix
-- propres déjà posés sur les nouveaux modules.
INSERT INTO public.app_modules (
  module_key, label, description, category, api_prefixes, nav_page_keys,
  enabled_by_default, is_active, is_protected, sort_order
)
SELECT
  'finitions',
  'Bibliothèque de finitions',
  'Référentiel contrôlé des traitements et finitions de surface.',
  'Production',
  ARRAY['/finitions'],
  ARRAY['finitions'],
  technical.enabled_by_default,
  technical.is_active,
  false,
  101
FROM public.app_modules AS technical
WHERE technical.module_key = 'pieces-techniques'
ON CONFLICT (module_key) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    api_prefixes = EXCLUDED.api_prefixes,
    nav_page_keys = EXCLUDED.nav_page_keys,
    is_protected = false,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

INSERT INTO public.app_modules (
  module_key, label, description, category, api_prefixes, nav_page_keys,
  enabled_by_default, is_active, is_protected, sort_order
)
SELECT
  'methodes-centres-frais',
  'Méthodes — Centres de frais',
  'Centres de frais, tarifs versionnés et référentiel associé.',
  'Production',
  ARRAY['/methodes/centres-frais', '/centre-frais'],
  ARRAY['methodes-centres-frais'],
  technical.enabled_by_default,
  technical.is_active,
  false,
  102
FROM public.app_modules AS technical
WHERE technical.module_key = 'pieces-techniques'
ON CONFLICT (module_key) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    api_prefixes = EXCLUDED.api_prefixes,
    nav_page_keys = EXCLUDED.nav_page_keys,
    is_protected = false,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

INSERT INTO public.app_modules (
  module_key, label, description, category, api_prefixes, nav_page_keys,
  enabled_by_default, is_active, is_protected, sort_order
)
SELECT
  'methodes-parc-machines',
  'Méthodes — Parc machine',
  'Qualification du parc machine et familles de machines.',
  'Production',
  ARRAY['/methodes/machines', '/methodes/familles-machine'],
  ARRAY['methodes-parc-machines'],
  technical.enabled_by_default,
  technical.is_active,
  false,
  103
FROM public.app_modules AS technical
WHERE technical.module_key = 'pieces-techniques'
ON CONFLICT (module_key) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    category = EXCLUDED.category,
    api_prefixes = EXCLUDED.api_prefixes,
    nav_page_keys = EXCLUDED.nav_page_keys,
    is_protected = false,
    sort_order = EXCLUDED.sort_order,
    updated_at = now();

-- Un override historique de Données techniques couvre logiquement les trois
-- sous-espaces avant leur séparation. On le recopie uniquement s'il n'existe pas
-- déjà de décision dédiée : les arbitrages plus fins restent prioritaires.
INSERT INTO public.app_module_user_access (user_id, module_key, access, updated_at, updated_by)
SELECT legacy.user_id, target.module_key, legacy.access, legacy.updated_at, legacy.updated_by
FROM public.app_module_user_access AS legacy
CROSS JOIN (VALUES ('finitions'), ('methodes-centres-frais'), ('methodes-parc-machines')) AS target(module_key)
WHERE legacy.module_key = 'pieces-techniques'
ON CONFLICT (user_id, module_key) DO NOTHING;

-- GED est un module autonome : son catalogue peut être actualisé sans remettre
-- à zéro les choix effectués en exploitation (default, activation et overrides).
INSERT INTO public.app_modules (
  module_key,
  label,
  description,
  category,
  api_prefixes,
  nav_page_keys,
  is_protected,
  sort_order
) VALUES (
  'ged',
  'Gestion documentaire',
  'Documents contrôlés, versions, classes documentaires et validations.',
  'Système',
  ARRAY['/ged'],
  ARRAY['ged'],
  false,
  195
)
ON CONFLICT (module_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  api_prefixes = EXCLUDED.api_prefixes,
  nav_page_keys = EXCLUDED.nav_page_keys,
  is_protected = false,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

COMMIT;
