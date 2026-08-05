\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Rollback GPT56-FEAT-CERP-0005 is restricted to disposable cerp_test';
  END IF;
  IF to_regclass('public.bon_livraison_pack_quality_documents') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.bon_livraison_pack_quality_documents) THEN
    RAISE EXCEPTION 'Rollback refused: emitted pack evidence exists';
  END IF;
  IF to_regclass('public.quality_delivery_release_policy') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.quality_delivery_release_policy WHERE status <> 'DRAFT') THEN
    RAISE EXCEPTION 'Rollback refused: signed or retired policy exists';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bon_livraison_pack_versions
    WHERE quality_release_preview_sha256 IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Rollback refused: qualified pack versions exist';
  END IF;
END;
$$;

BEGIN;
DROP TRIGGER IF EXISTS trg_bon_livraison_pack_quality_documents_append_only_0005 ON public.bon_livraison_pack_quality_documents;
DROP TABLE IF EXISTS public.bon_livraison_pack_quality_documents;
DROP FUNCTION IF EXISTS public.bon_livraison_pack_quality_documents_append_only_0005();
DROP TRIGGER IF EXISTS trg_bon_livraison_pack_snapshot_guard_0005 ON public.bon_livraison_pack_versions;
DROP FUNCTION IF EXISTS public.bon_livraison_pack_snapshot_guard_0005();
ALTER TABLE public.bon_livraison_pack_versions
  DROP COLUMN IF EXISTS quality_release_snapshot,
  DROP COLUMN IF EXISTS quality_policy_sha256,
  DROP COLUMN IF EXISTS quality_policy_id,
  DROP COLUMN IF EXISTS quality_release_preview_sha256,
  DROP COLUMN IF EXISTS quality_release_state;
DROP TRIGGER IF EXISTS trg_quality_delivery_release_policy_guard_0005 ON public.quality_delivery_release_policy;
DROP TABLE IF EXISTS public.quality_delivery_release_policy;
DROP FUNCTION IF EXISTS public.quality_delivery_release_policy_guard_0005();
COMMIT;
