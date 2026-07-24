-- 20260721_commandes_fournisseurs_core.preflight.sql — READ-ONLY, run BEFORE apply.
-- #172 : vérifie les prérequis réels de la base (jamais déduits du dépôt — leçon "baseliné ≠ exécuté").

\echo '--- Preflight #172 commandes fournisseurs ---'
SELECT current_database() AS db, now() AS at;

-- 1) Dépendances amont obligatoires
SELECT
  to_regclass('public.fournisseurs')                IS NOT NULL AS has_fournisseurs,
  to_regclass('public.fournisseur_catalogue')       IS NOT NULL AS has_catalogue,
  to_regclass('public.fournisseur_contacts')        IS NOT NULL AS has_contacts,
  to_regclass('public.fournisseur_adresses')        IS NOT NULL AS has_adresses,
  to_regclass('public.articles')                    IS NOT NULL AS has_articles,
  to_regclass('public.receptions_fournisseurs')     IS NOT NULL AS has_receptions,
  to_regclass('public.reception_fournisseur_lignes')IS NOT NULL AS has_reception_lignes,
  to_regclass('public.currencies')                  IS NOT NULL AS has_currencies,
  to_regclass('public.magasins')                    IS NOT NULL AS has_magasins,
  to_regclass('public.users')                       IS NOT NULL AS has_users,
  to_regprocedure('public.fn_next_issued_code_value(text)') IS NOT NULL AS has_code_fn,
  to_regprocedure('public.tg_set_updated_at()')          IS NOT NULL AS has_updated_at_trigger_fn;

-- 2) État actuel des objets #172 (attendu : tout à false avant le premier apply)
SELECT
  to_regclass('public.commande_fournisseur')              IS NOT NULL AS has_cf,
  to_regclass('public.commande_fournisseur_ligne')        IS NOT NULL AS has_cf_ligne,
  to_regclass('public.commande_fournisseur_transition')   IS NOT NULL AS has_cf_transition,
  to_regclass('public.commande_fournisseur_document')     IS NOT NULL AS has_cf_document,
  to_regclass('public.commande_fournisseur_ligne_besoin') IS NOT NULL AS has_cf_besoin,
  to_regclass('public.commande_fournisseur_idempotence')  IS NOT NULL AS has_cf_idem;

-- 3) Colonnes additives réceptions déjà présentes ?
SELECT
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='receptions_fournisseurs'
            AND column_name='commande_fournisseur_id')  AS reception_header_linked,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='reception_fournisseur_lignes'
            AND column_name='commande_fournisseur_ligne_id') AS reception_line_linked;

-- 4) Whitelist codification actuelle (doit refuser BCF avant apply → 22023 attendu)
SELECT prosrc ~ 'BCF' AS whitelist_already_has_bcf
FROM pg_proc WHERE proname = 'fn_next_issued_code_value' AND pronamespace = 'public'::regnamespace;

-- 5) Migration déjà enregistrée ?
SELECT EXISTS (
  SELECT 1 FROM public.cerp_schema_migrations
  WHERE filename = '20260721_commandes_fournisseurs_core.sql'
) AS migration_already_recorded;
