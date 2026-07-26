-- 20260726_fix_facturation_child_trigger_227.sql
--
-- CORRECTIF BLOQUANT découvert pendant #275 (banc de réconciliation du Reporting
-- commercial 360, exécuté contre un vrai PostgreSQL).
--
-- Symptôme
-- --------
-- Sur toute base où `20260725_facturation_payments_227.sql` a été appliqué, INSERT
-- ou UPDATE sur `facture_ligne`, `avoir_ligne`, `facture_source_allocations` ou
-- `avoir_source_allocations` échoue systématiquement :
--
--     ERROR: record "new" has no field "due_date"
--     CONTEXTE: PL/pgSQL function fn_protect_facturation_child_227() line 24 at IF
--
-- Autrement dit : aucune ligne de facture ne peut être créée. Le workflow de
-- facturation #227 est inopérant en base, sur cerp_test ET sur cerp_prod.
-- Le défaut est resté invisible parce que `facture`, `avoir` et `paiement` sont
-- vides dans les deux bases : personne n'a encore créé de facture.
--
-- Cause
-- -----
-- `fn_protect_facturation_child_227` teste, dans UNE SEULE condition `IF` :
--
--     IF TG_TABLE_NAME = 'facture_echeance' AND … AND NEW.due_date = OLD.due_date …
--
-- PL/pgSQL prépare la condition entière comme une seule expression SQL. La
-- résolution du champ `due_date` sur l'enregistrement `NEW` a donc lieu AVANT toute
-- évaluation booléenne : le court-circuit sur `TG_TABLE_NAME` n'a jamais lieu, et
-- la fonction échoue pour toutes les tables qui n'ont pas de colonne `due_date`.
--
-- Correctif
-- ---------
-- Imbriquer le test : le bloc qui référence les colonnes de `facture_echeance`
-- n'est atteint — donc préparé — que lorsque la table déclenchante est bien
-- `facture_echeance`. Aucune règle métier n'est modifiée : mêmes tables protégées,
-- mêmes statuts immuables, même exception. Seule la structure du `IF` change.
--
-- Sûreté
-- - `CREATE OR REPLACE FUNCTION` : idempotent, rejouable.
-- - Aucune table, colonne, contrainte, donnée ni trigger n'est créé ou supprimé.
-- - Les triggers existants continuent de pointer sur la même fonction.
--
-- Cible : cerp_test d'abord ; cerp_prod uniquement après validation humaine explicite.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.facture_echeance') IS NULL THEN
    RAISE EXCEPTION 'Correctif #227 non applicable : public.facture_echeance absente';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.fn_protect_facturation_child_227()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  IF TG_TABLE_NAME IN ('facture_ligne', 'facture_source_allocations', 'facture_echeance') THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.facture WHERE id = OLD.facture_id;
    ELSE
      SELECT statut INTO parent_status FROM public.facture WHERE id = NEW.facture_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_ligne' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.avoir WHERE id = OLD.avoir_id;
    ELSE
      SELECT statut INTO parent_status FROM public.avoir WHERE id = NEW.avoir_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'avoir_source_allocations' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT statut INTO parent_status FROM public.avoir WHERE id = OLD.avoir_id;
    ELSE
      SELECT statut INTO parent_status FROM public.avoir WHERE id = NEW.avoir_id;
    END IF;
  END IF;

  -- Imbrication volontaire : les champs propres à `facture_echeance` ne sont
  -- référencés que si le trigger provient bien de cette table. PL/pgSQL ne prépare
  -- l'expression interne que lorsqu'elle est atteinte.
  IF TG_TABLE_NAME = 'facture_echeance' AND TG_OP = 'UPDATE' THEN
    IF parent_status IN ('ISSUED', 'PARTIALLY_PAID', 'PAID')
       AND NEW.facture_id = OLD.facture_id
       AND NEW.due_date = OLD.due_date
       AND NEW.label = OLD.label
       AND NEW.amount_due = OLD.amount_due
       AND NEW.created_by = OLD.created_by
       AND NEW.amount_allocated >= OLD.amount_allocated THEN
      -- Seule évolution autorisée sur une facture émise : l'avancement du lettrage.
      RETURN NEW;
    END IF;
  END IF;

  IF parent_status IN (
    'ISSUED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED',
    'emise', 'envoyee', 'partielle', 'payee', 'annulee', 'emis', 'annule'
  ) THEN
    RAISE EXCEPTION 'children of issued or cancelled finance evidence are immutable' USING ERRCODE = '55000';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

COMMENT ON FUNCTION public.fn_protect_facturation_child_227() IS
  'Immutabilite des enfants de pieces financieres (#227). Correctif #275 : le test propre a facture_echeance est imbrique, sinon PL/pgSQL resout NEW.due_date pour toutes les tables et bloque tout INSERT.';

COMMIT;
