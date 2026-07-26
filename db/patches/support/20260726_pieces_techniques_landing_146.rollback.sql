-- Rollback gardé #146 — supprime uniquement les six index de lecture.
-- À exécuter uniquement avec :
--   SET cerp.allow_146_index_rollback = 'on';

DO $$
BEGIN
  IF current_setting('cerp.allow_146_index_rollback', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      'Rollback #146 refusé. Positionner cerp.allow_146_index_rollback=on après validation humaine.';
  END IF;
END
$$;

BEGIN;

DROP INDEX IF EXISTS public.pt_operations_piece_146_idx;
DROP INDEX IF EXISTS public.pieces_techniques_landing_146_idx;
DROP INDEX IF EXISTS public.pieces_techniques_ensemble_146_idx;
DROP INDEX IF EXISTS public.pieces_techniques_without_article_146_idx;
DROP INDEX IF EXISTS public.ptv_plan_reference_146_idx;
DROP INDEX IF EXISTS public.ptv_indice_146_idx;

COMMIT;
