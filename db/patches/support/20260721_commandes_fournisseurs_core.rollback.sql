-- 20260721_commandes_fournisseurs_core.rollback.sql — GUARDED, non-destructive by default.
-- #172 : le rollback ne détruit JAMAIS des données métier. Il refuse de s'exécuter si une
-- commande fournisseur existe. À n'utiliser qu'immédiatement après un apply raté/vide,
-- après sauvegarde, et avec validation humaine.

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.commande_fournisseur') IS NULL THEN
    RAISE NOTICE '#172 rollback: rien à faire (tables absentes)';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.commande_fournisseur' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION '#172 rollback REFUSÉ : % commande(s) fournisseur existent. Archiver/annuler métier, jamais DROP.', n;
  END IF;

  -- Ordre inverse des dépendances. Les colonnes additives réceptions sont conservées
  -- (nullable, inertes) pour ne pas toucher au sous-système réceptions ; seules les FK
  -- vers les tables supprimées doivent tomber avec elles.
  EXECUTE 'ALTER TABLE public.receptions_fournisseurs DROP CONSTRAINT IF EXISTS receptions_fournisseurs_cf_fkey';
  EXECUTE 'ALTER TABLE public.reception_fournisseur_lignes DROP CONSTRAINT IF EXISTS reception_fournisseur_lignes_cf_ligne_fkey';

  EXECUTE 'DROP TABLE IF EXISTS public.commande_fournisseur_idempotence';
  EXECUTE 'DROP TABLE IF EXISTS public.commande_fournisseur_ligne_besoin';
  EXECUTE 'DROP TABLE IF EXISTS public.commande_fournisseur_document';
  EXECUTE 'DROP TABLE IF EXISTS public.commande_fournisseur_transition';
  EXECUTE 'DROP TABLE IF EXISTS public.commande_fournisseur_ligne';
  EXECUTE 'DROP TABLE IF EXISTS public.commande_fournisseur';

  RAISE NOTICE '#172 rollback: tables vides supprimées. La whitelist BCF de fn_next_issued_code_value est conservée (inerte, non risquée).';
END $$;

-- Nettoyage du registre si (et seulement si) le rollback ci-dessus a abouti.
DELETE FROM public.cerp_schema_migrations
WHERE filename = '20260721_commandes_fournisseurs_core.sql'
  AND to_regclass('public.commande_fournisseur') IS NULL;

COMMIT;
