-- Rollback 20260729_methodes_gamme_referentials.
--
-- À N'EXÉCUTER QUE sur une base où le patch vient d'être appliqué et où AUCUNE
-- donnée métier n'a encore été saisie dans les nouveaux objets. Le script
-- REFUSE de s'exécuter si un tarif de centre de frais existe ou si une
-- opération référence déjà un tarif : ces informations ne se reconstruisent pas.
--
-- `taux_horaire_legacy` est supprimé en dernier — c'est une COPIE de
-- `taux_horaire`, qui n'a jamais été modifié : aucune donnée d'origine n'est
-- perdue par ce retrait.

BEGIN;

DO $$
DECLARE
  v_rates    bigint := 0;
  v_frozen   bigint := 0;
  v_prog     bigint := 0;
  v_families bigint := 0;
BEGIN
  IF to_regclass('public.production_cost_center_rates') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_rates FROM public.production_cost_center_rates;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='pieces_techniques_operations'
               AND column_name='cf_rate_id') THEN
    SELECT COUNT(*) INTO v_frozen FROM public.pieces_techniques_operations WHERE cf_rate_id IS NOT NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='pieces_techniques_operations'
               AND column_name='numero_programme') THEN
    SELECT COUNT(*) INTO v_prog FROM public.pieces_techniques_operations WHERE numero_programme IS NOT NULL;
  END IF;
  IF to_regclass('public.production_machine_families') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_families FROM public.production_machine_families
    WHERE code NOT IN ('T','F','TTRAD','FTRAD','DECOUPE');
  END IF;

  IF v_rates > 0 OR v_frozen > 0 OR v_prog > 0 OR v_families > 0 THEN
    RAISE EXCEPTION
      'Rollback refusé : % tarif(s), % opération(s) tarifée(s), % numéro(s) de programme, % famille(s) ajoutée(s). Ces données seraient perdues.',
      v_rates, v_frozen, v_prog, v_families;
  END IF;
END $$;

-- 1) Opérations de gamme.
ALTER TABLE public.pieces_techniques_operations
  DROP CONSTRAINT IF EXISTS pt_operations_family_fkey,
  DROP CONSTRAINT IF EXISTS pt_operations_cf_rate_fkey,
  DROP CONSTRAINT IF EXISTS pt_operations_temps_fabrication_ck,
  DROP CONSTRAINT IF EXISTS pt_operations_taux_source_ck,
  DROP CONSTRAINT IF EXISTS pt_operations_programme_ck;

DROP INDEX IF EXISTS public.pt_operations_gamme_phase_uidx;
DROP INDEX IF EXISTS public.pt_operations_gamme_ordre_idx;

-- Le CHECK revient à son périmètre d'origine (sans DECOUPE) uniquement si
-- aucune opération n'utilise ce type.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pieces_techniques_operations WHERE type_operation = 'DECOUPE') THEN
    ALTER TABLE public.pieces_techniques_operations
      DROP CONSTRAINT IF EXISTS pieces_techniques_operations_type_operation_check;
    ALTER TABLE public.pieces_techniques_operations
      ADD CONSTRAINT pieces_techniques_operations_type_operation_check
      CHECK (type_operation IS NULL OR type_operation IN
        ('TOURNAGE','FRAISAGE','REPRISE','CONTROLE','LAVAGE','SOUS_TRAITANCE','EMBALLAGE','AUTRE'));
  ELSE
    RAISE NOTICE 'CHECK type_operation conservé avec DECOUPE : des opérations l''utilisent.';
  END IF;
END $$;

ALTER TABLE public.pieces_techniques_operations
  DROP COLUMN IF EXISTS numero_programme,
  DROP COLUMN IF EXISTS machine_family_code,
  DROP COLUMN IF EXISTS temps_fabrication,
  DROP COLUMN IF EXISTS cf_rate_id,
  DROP COLUMN IF EXISTS taux_horaire_source,
  DROP COLUMN IF EXISTS taux_horaire_effective_at,
  DROP COLUMN IF EXISTS designation_auto,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS taux_horaire_legacy;

-- 2) Snapshot OF.
ALTER TABLE public.of_operations
  DROP CONSTRAINT IF EXISTS of_operations_temps_fabrication_ck;
ALTER TABLE public.of_operations
  DROP COLUMN IF EXISTS numero_programme,
  DROP COLUMN IF EXISTS machine_family_code,
  DROP COLUMN IF EXISTS cf_code_snapshot,
  DROP COLUMN IF EXISTS cf_rate_id,
  DROP COLUMN IF EXISTS temps_fabrication_planned,
  DROP COLUMN IF EXISTS hourly_rate_source,
  DROP COLUMN IF EXISTS hourly_rate_effective_at;

-- 3) Machines.
ALTER TABLE public.machines
  DROP CONSTRAINT IF EXISTS machines_family_fkey,
  DROP CONSTRAINT IF EXISTS machines_cf_fkey,
  DROP CONSTRAINT IF EXISTS machines_validity_ck;
DROP INDEX IF EXISTS public.machines_family_idx;
DROP INDEX IF EXISTS public.machines_cf_idx;
ALTER TABLE public.machines
  DROP COLUMN IF EXISTS machine_family_code,
  DROP COLUMN IF EXISTS cf_id,
  DROP COLUMN IF EXISTS valid_from,
  DROP COLUMN IF EXISTS valid_to;

-- 4) Tarifs versionnés puis centres de frais.
DROP TABLE IF EXISTS public.production_cost_center_rates;

ALTER TABLE public.centres_frais
  DROP CONSTRAINT IF EXISTS centres_frais_statut_ck,
  DROP CONSTRAINT IF EXISTS centres_frais_family_fkey,
  DROP CONSTRAINT IF EXISTS centres_frais_created_by_fkey,
  DROP CONSTRAINT IF EXISTS centres_frais_updated_by_fkey;
DROP INDEX IF EXISTS public.centres_frais_code_uidx;
DROP INDEX IF EXISTS public.centres_frais_family_idx;
DROP INDEX IF EXISTS public.centres_frais_statut_idx;
ALTER TABLE public.centres_frais
  DROP COLUMN IF EXISTS machine_family_code,
  DROP COLUMN IF EXISTS statut,
  DROP COLUMN IF EXISTS devise,
  DROP COLUMN IF EXISTS designation_modele,
  DROP COLUMN IF EXISTS designation_auto,
  DROP COLUMN IF EXISTS commentaire,
  DROP COLUMN IF EXISTS archived_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS updated_by;

-- 5) Référentiel de familles (vide de tout ajout métier, cf. garde initiale).
DROP TABLE IF EXISTS public.production_machine_families;

COMMIT;
