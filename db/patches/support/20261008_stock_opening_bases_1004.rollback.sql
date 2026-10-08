-- Manual only. Never discard a declared financial basis or published opening.
BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.stock_valuation_opening_bases) OR EXISTS(SELECT 1 FROM public.stock_valuation_entries WHERE source_snapshot ? 'opening_basis_id') THEN RAISE EXCEPTION 'Declared opening proofs must be retained'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_stock_valuation_entry_guard_983() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior public.stock_valuation_balances%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Stock valuation entries are immutable; append a justified correction' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control c WHERE c.mode='ACTIVE'
    AND c.reporting_currency=NEW.currency AND c.formula_version=NEW.formula_version)
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex') THEN
    RAISE EXCEPTION 'Stock valuation entry requires the active Stock projector and its proof' USING ERRCODE='23514';
  END IF;
  IF NEW.movement_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j
    WHERE j.movement_id=NEW.movement_id AND j.article_id=NEW.article_id AND j.sequence=NEW.source_sequence
      AND NEW.source_snapshot->>'stock_source_sha256'=j.source_sha256) THEN
    RAISE EXCEPTION 'Stock valuation entry is not linked to its immutable posting' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='OPENING' AND (
    NEW.owner_key IS NULL OR NEW.stock_unit IS NULL OR NEW.quantity_delta IS NULL
    OR NEW.value_delta IS NOT NULL OR NEW.movement_value IS NOT NULL
    OR (NEW.source_snapshot->'after_state'->>'quantity')::numeric IS DISTINCT FROM NEW.quantity_delta
    OR NOT ((NEW.source_snapshot->'after_state'->>'value') IS NULL AND NEW.reliability='UNKNOWN'
      OR NEW.quantity_delta=0 AND (NEW.source_snapshot->'after_state'->>'value')::numeric=0 AND NEW.reliability='VERIFIED')) THEN
    RAISE EXCEPTION 'Opening quantities cannot introduce an unsupported historical price' USING ERRCODE='23514';
  END IF;
  IF NEW.kind='UNRESOLVED' AND NEW.source_snapshot->'blocking' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Unresolved Stock evidence must suppress financial publication' USING ERRCODE='23514';
  END IF;
  IF NEW.kind NOT IN('OPENING','ZERO','UNRESOLVED') THEN
    SELECT * INTO prior FROM public.stock_valuation_balances
      WHERE article_id=NEW.article_id AND owner_key=NEW.owner_key AND stock_unit=NEW.stock_unit AND currency=NEW.currency;
    IF NOT FOUND OR NEW.source_snapshot->>'previous_entry_id' IS DISTINCT FROM prior.latest_entry_id::text
      OR (NEW.source_snapshot->'before_state'->>'quantity')::numeric IS DISTINCT FROM prior.quantity
      OR (NEW.source_snapshot->'before_state'->>'value')::numeric IS DISTINCT FROM prior.value
      OR NEW.source_snapshot->'before_state'->>'reliability' IS DISTINCT FROM prior.reliability
      OR NEW.source_snapshot->'before_state'->>'sourceRef' IS DISTINCT FROM prior.source_ref
      OR NEW.source_snapshot->'result'->'before' IS DISTINCT FROM NEW.source_snapshot->'before_state'
      OR NEW.source_snapshot->'result'->'after' IS DISTINCT FROM NEW.source_snapshot->'after_state'
      OR NEW.source_snapshot->'result'->>'formulaVersion' IS DISTINCT FROM NEW.formula_version
      OR (NEW.source_snapshot->'result'->>'quantityDelta')::numeric IS DISTINCT FROM NEW.quantity_delta
      OR (NEW.source_snapshot->'result'->>'valueDelta')::numeric IS DISTINCT FROM NEW.value_delta
      OR (NEW.source_snapshot->'result'->>'movementValue')::numeric IS DISTINCT FROM NEW.movement_value
      OR NEW.source_snapshot->'result'->>'movementReliability' IS DISTINCT FROM NEW.reliability THEN
      RAISE EXCEPTION 'Stock valuation transition must extend its exact immutable balance chain' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.kind NOT IN('ZERO','UNRESOLVED') AND (
    NEW.source_snapshot->'after_state'->'scope'->>'articleId' IS DISTINCT FROM NEW.article_id::text
    OR NEW.source_snapshot->'after_state'->'scope'->>'owner' IS DISTINCT FROM NEW.owner_key
    OR NEW.source_snapshot->'after_state'->'scope'->>'unit' IS DISTINCT FROM NEW.stock_unit
    OR NEW.source_snapshot->'after_state'->'scope'->>'currency' IS DISTINCT FROM NEW.currency) THEN
    RAISE EXCEPTION 'Stock valuation state must retain its article, owner, unit and currency' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TABLE public.stock_valuation_opening_bases;
DROP FUNCTION public.fn_stock_opening_basis_guard_1004();
DROP FUNCTION public.fn_stock_opening_entry_basis_1004(uuid,text,text,text,numeric,numeric,jsonb);
DROP FUNCTION public.fn_stock_opening_candidate_1004(uuid,text);
DROP FUNCTION public.fn_stock_opening_scope_1004(text);
COMMIT;
