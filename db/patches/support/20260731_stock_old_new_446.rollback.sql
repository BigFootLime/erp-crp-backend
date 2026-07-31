\set ON_ERROR_STOP on

-- #446 guarded rollback. It is solely a compensation for an unused test
-- installation. Once OLD/NEW stock, lot traceability, or a trace reference has
-- been used, restore a verified backup instead of deleting industrial evidence.
BEGIN;

DO $$
DECLARE
  v_evidence_count bigint;
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION '#446 rollback is restricted to cerp_test (current: %)', current_database();
  END IF;

  SELECT
    (SELECT count(*) FROM public.stock_lot_trace_references)
    + (SELECT count(*) FROM public.lots
       WHERE stock_trace_code IS NOT NULL
          OR qr_payload IS NOT NULL
          OR origin_stock_scope IS NOT NULL)
    + (SELECT count(*)
       FROM public.stock_movement_lines line
       JOIN public.magasins src ON src.id = line.src_magasin_id
       WHERE src.code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP'))
    + (SELECT count(*)
       FROM public.stock_movement_lines line
       JOIN public.magasins dst ON dst.id = line.dst_magasin_id
       WHERE dst.code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP'))
    + (SELECT count(*) FROM public.emplacements emplacement
       JOIN public.magasins magasin ON magasin.id = emplacement.magasin_id
       WHERE magasin.code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP'))
    + (SELECT count(*) FROM public.articles_achat
       WHERE reference_client IS NOT NULL
          OR indice_client IS NOT NULL
          OR numero_client IS NOT NULL)
  INTO v_evidence_count;

  IF v_evidence_count > 0 THEN
    RAISE EXCEPTION
      '#446 rollback refused: % OLD/NEW movement, lot, trace reference, location, or Fourniture Client value(s) exist; restore a verified backup instead',
      v_evidence_count;
  END IF;
END $$;

DELETE FROM public.magasins
WHERE code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP')
   OR code_magasin IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP');

DELETE FROM public.warehouses
WHERE code IN ('OLD-PF', 'OLD-MP', 'NEW-PF', 'NEW-MP');

UPDATE public.article_category_ref
SET label = 'Achat-Transformé'
WHERE code = 'achat_transforme'
  AND label = 'Fourniture Client';

DROP INDEX IF EXISTS public.stock_lot_trace_references_lot_446_idx;
DROP TABLE IF EXISTS public.stock_lot_trace_references;
DROP INDEX IF EXISTS public.lots_stock_trace_code_446_uq;
DROP SEQUENCE IF EXISTS public.stock_trace_code_446_seq;

ALTER TABLE public.lots
  DROP CONSTRAINT IF EXISTS lots_qr_payload_446_ck,
  DROP CONSTRAINT IF EXISTS lots_stock_trace_code_446_ck,
  DROP CONSTRAINT IF EXISTS lots_origin_stock_scope_446_ck,
  DROP COLUMN IF EXISTS qr_payload,
  DROP COLUMN IF EXISTS stock_trace_code,
  DROP COLUMN IF EXISTS origin_stock_scope;

DROP INDEX IF EXISTS public.magasins_stock_scope_446_idx;
ALTER TABLE public.magasins
  DROP CONSTRAINT IF EXISTS magasins_stock_scope_446_ck,
  DROP COLUMN IF EXISTS stock_scope;

DROP INDEX IF EXISTS public.warehouses_stock_scope_446_idx;
ALTER TABLE public.warehouses
  DROP CONSTRAINT IF EXISTS warehouses_stock_scope_446_ck,
  DROP COLUMN IF EXISTS stock_scope;

ALTER TABLE public.articles_achat
  DROP COLUMN IF EXISTS reference_client,
  DROP COLUMN IF EXISTS indice_client,
  DROP COLUMN IF EXISTS numero_client;

COMMIT;
