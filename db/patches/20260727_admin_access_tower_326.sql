-- Module « Tour de contrôle des accès » — socle serveur du filtrage module par compte.
-- Issue frontend #326 ; issue backend #200.
-- Migration ADDITIVE + IDEMPOTENTE uniquement (aucun DROP, aucun changement de type,
-- aucune restriction posée par le patch : tout module naît débloqué).
-- Le statut superadmin n'est accordé par AUCUNE API : uniquement par le seed gardé
-- db/seeds/access-tower-superadmin-keenan.sql.
-- Verify : db/patches/support/20260727_admin_access_tower_326.verify.sql
-- Preflight : db/patches/support/20260727_admin_access_tower_326.preflight.sql
-- Rollback : db/patches/support/20260727_admin_access_tower_326.rollback.sql

BEGIN;

-- ------------------------------------------------------------------ Marqueur de compte
-- `is_superadmin` est un marqueur de compte, pas un rôle métier : il ne participe
-- pas au RBAC #315 et ne peut donc pas être obtenu par une attribution de rôle.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false;

-- ------------------------------------------------------------------ Catalogue de modules
CREATE TABLE IF NOT EXISTS public.app_modules (
  module_key text PRIMARY KEY,
  label text NOT NULL,
  description text NULL,
  category text NOT NULL DEFAULT 'Autre',
  api_prefixes text[] NOT NULL DEFAULT '{}',
  nav_page_keys text[] NOT NULL DEFAULT '{}',
  enabled_by_default boolean NOT NULL DEFAULT true,
  is_protected boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ Décisions explicites
-- L'absence de ligne signifie « hérité du catalogue » : c'est la valeur par défaut,
-- jamais un refus. Seule une décision prise à la main crée une ligne ici.
CREATE TABLE IF NOT EXISTS public.app_module_user_access (
  user_id integer NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  module_key text NOT NULL REFERENCES public.app_modules(module_key) ON UPDATE CASCADE ON DELETE CASCADE,
  access text NOT NULL CHECK (access IN ('GRANTED', 'DENIED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer NULL REFERENCES public.users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_app_module_user_access_module
  ON public.app_module_user_access(module_key, user_id);

-- ------------------------------------------------------------------ Journal append-only
-- Aucune clé étrangère ici, volontairement : le trigger append-only interdit tout
-- UPDATE, donc un `ON DELETE SET NULL` sur user_id ferait échouer la suppression du
-- compte. Le journal doit survivre à la disparition de l'acteur comme de la cible.
CREATE TABLE IF NOT EXISTS public.app_module_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id integer NULL,
  module_key text NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('GRANTED', 'DENIED', 'INHERITED', 'DEFAULT_CHANGED', 'UNLOCK_ALL')
  ),
  previous_state text NULL,
  next_state text NULL,
  actor_user_id integer NULL,
  source text NOT NULL DEFAULT 'admin',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_module_access_events_recent
  ON public.app_module_access_events(occurred_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_app_module_access_events_user
  ON public.app_module_access_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_module_access_events_module
  ON public.app_module_access_events(module_key, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.fn_app_module_access_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app_module_access_events is append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS trg_app_module_access_events_append_only
  ON public.app_module_access_events;
CREATE TRIGGER trg_app_module_access_events_append_only
BEFORE UPDATE OR DELETE ON public.app_module_access_events
FOR EACH ROW EXECUTE FUNCTION public.fn_app_module_access_events_append_only();

-- ------------------------------------------------------------------ Seed du catalogue
-- Miroir exact de src/module/access-control/domain/module-catalog.ts.
-- `enabled_by_default` et `is_active` sont ABSENTS du SET de conflit : une décision
-- d'exploitation déjà prise ne doit jamais être écrasée par une réapplication.
INSERT INTO public.app_modules (
  module_key, label, description, category, api_prefixes, nav_page_keys, is_protected, sort_order
) VALUES
  ('clients', 'Clients', 'Comptes clients, contacts, adresses et conditions de règlement.', 'Commerce',
   ARRAY['/clients', '/payment-modes', '/billers', '/banking-info'], ARRAY['clients'], false, 10),
  ('devis', 'Devis', 'Chiffrage et cycle de vie des devis clients.', 'Commerce',
   ARRAY['/devis'], ARRAY['devis'], false, 20),
  ('commandes-clients', 'Commandes clients', 'Commandes fermes, cadres et internes, appels de livraison.', 'Commerce',
   ARRAY['/commandes'], ARRAY['commandes'], false, 30),
  ('livraisons', 'Livraisons', 'Préparation, expédition et bons de livraison.', 'Commerce',
   ARRAY['/livraisons'], ARRAY['livraisons'], false, 40),
  ('affaires', 'Affaires', 'Affaires commerciales et projets rattachés.', 'Commerce',
   ARRAY['/affaires'], ARRAY['affaires'], false, 50),
  ('facturation', 'Facturation', 'Factures, avoirs, règlements et tarification.', 'Commerce',
   ARRAY['/factures', '/avoirs', '/paiements', '/tarification'], ARRAY['factures'], false, 60),
  ('reporting-commercial', 'Reporting commercial', 'Indicateurs commerciaux et exports gouvernés.', 'Commerce',
   ARRAY['/reporting'], ARRAY['reporting-commercial'], false, 70),
  ('fournisseurs', 'Fournisseurs', 'Référentiel fournisseurs et écosystème achat.', 'Achats',
   ARRAY['/fournisseurs'], ARRAY['fournisseurs'], false, 80),
  ('commandes-fournisseurs', 'Commandes fournisseurs', 'Bons de commande fournisseurs et suivi des accusés.', 'Achats',
   ARRAY['/commandes-fournisseurs'], ARRAY['commandes-fournisseurs'], false, 90),
  ('pieces-techniques', 'Données techniques', 'Pièces techniques, versions, gammes et dossiers d’opération.', 'Production',
   ARRAY['/pieces-techniques', '/piece-technique-versions', '/gammes', '/dossiers'],
   ARRAY['pieces-techniques'], false, 100),
  ('production', 'Production', 'Ordres de fabrication, planning, pointages et poste opérateur.', 'Production',
   ARRAY['/production', '/planning', '/programmations'],
   ARRAY['production-dashboard', 'machines-postes', 'production-planning', 'production-execution',
         'atelier-station', 'production-pointages', 'ordres-fabrication'], false, 110),
  ('qualite', 'Qualité', 'Plans de contrôle, non-conformités, réceptions et dérogations.', 'Qualité',
   ARRAY['/qualite', '/receptions'],
   ARRAY['qualite-center', 'qualite-controls', 'qualite-non-conformities', 'receptions'], false, 120),
  ('metrologie', 'Métrologie', 'Parc de moyens de mesure, étalonnages et certificats.', 'Qualité',
   ARRAY['/metrologie'], ARRAY['metrologie'], false, 130),
  ('tracabilite', 'Traçabilité', 'Chaînage matière, généalogie des lots et dossiers as-built.', 'Qualité',
   ARRAY['/traceability', '/asbuilt'], ARRAY['traceabilite'], false, 140),
  ('stock', 'Stock', 'Articles, mouvements, emplacements et inventaires.', 'Stock',
   ARRAY['/stock'],
   ARRAY['stock-dashboard', 'stock-articles', 'stock-mouvements', 'stock-inventaires'], false, 150),
  ('outillage', 'Outillage', 'Parc d’outils coupants et sorties atelier.', 'Stock',
   ARRAY['/outils'], ARRAY['outils', 'outils-new', 'outils-retirer'], false, 160),
  ('temps-deplacements', 'Temps & Déplacements', 'Pointages horaires et frais kilométriques.', 'Ressources humaines',
   ARRAY['/time-clock'], ARRAY['td-*'], false, 170),
  ('pilotage-projet', 'Pilotage projet', 'Project Office : lots, jalons, décisions et preuves.', 'Système',
   ARRAY['/project-office'], ARRAY['po-*'], false, 180),
  ('import-clipper', 'Migration CLIPPER', 'Assistant de reprise des données historiques CLIPPER.', 'Système',
   ARRAY['/import-assistant'], ARRAY['import-assistant'], false, 190),
  ('administration', 'Administration', 'Comptes, rôles, réglages ERP et tour de contrôle des accès.', 'Système',
   ARRAY['/admin'], ARRAY['administration', 'erp-settings', 'acces'], true, 200)
ON CONFLICT (module_key) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  api_prefixes = EXCLUDED.api_prefixes,
  nav_page_keys = EXCLUDED.nav_page_keys,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

-- `is_protected` est une invariante de code, pas une préférence d'exploitation :
-- on la réaffirme sans jamais toucher aux défauts choisis par l'administrateur.
UPDATE public.app_modules
SET is_protected = true, updated_at = now()
WHERE module_key = 'administration'
  AND is_protected IS DISTINCT FROM true;

-- Un module protégé ne peut pas rester refusé : le patch efface les seules
-- restrictions qui rendraient l'ERP inadministrable, et rien d'autre.
DELETE FROM public.app_module_user_access a
USING public.app_modules m
WHERE m.module_key = a.module_key
  AND m.is_protected
  AND a.access = 'DENIED';

-- ------------------------------------------------------------------ Droits applicatifs
-- Les patches sont appliqués par le rôle système `postgres`, tandis que l'API tourne
-- avec `cerp_app`. Sans grant explicite, le gate d'accès recevrait une erreur de
-- permission sur chaque requête. `app_modules` n'est pas administrable par l'API :
-- seul `enabled_by_default` est modifiable, jamais le catalogue lui-même.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT ON TABLE public.app_modules TO cerp_app;
    GRANT UPDATE (enabled_by_default, updated_at) ON TABLE public.app_modules TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.app_module_user_access
      TO cerp_app;
    GRANT SELECT, INSERT
      ON TABLE public.app_module_access_events
      TO cerp_app;
  ELSE
    RAISE NOTICE 'role cerp_app absent — aucun grant appliqué';
  END IF;
END
$grants$;

COMMIT;
