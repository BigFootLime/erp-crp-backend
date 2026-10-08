-- Future OF receipt facts. No opening backfill, price inference or activation.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stock_valuation_projector_control IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control WHERE singleton AND mode='PREPARED'
    AND NOT initialized AND last_sequence=0) OR EXISTS(SELECT 1 FROM public.stock_valuation_entries) THEN
    RAISE EXCEPTION 'Manufacturing provenance requires the empty inactive Stock projector';
  END IF;
END $$;

CREATE TABLE public.stock_valuation_manufacturing_boundary (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1)
);
INSERT INTO public.stock_valuation_manufacturing_boundary(singleton) VALUES(true);
CREATE TRIGGER stock_manufacturing_boundary_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_manufacturing_boundary FOR EACH ROW EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();
CREATE TRIGGER stock_manufacturing_boundary_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_manufacturing_boundary FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();

CREATE TABLE public.stock_valuation_manufacturing_sources (
  movement_id uuid PRIMARY KEY REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  posting_transaction text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_issues jsonb NOT NULL CHECK(jsonb_typeof(source_issues)='array')
);
CREATE FUNCTION public.fn_stock_manufacturing_source_guard_995() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' OR pg_trigger_depth()<3 OR NEW.posting_transaction<>pg_current_xact_id()::text
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=NEW.movement_id
      AND j.posting_transaction=NEW.posting_transaction
      AND NEW.source_snapshot->>'movement_id'=j.movement_id::text
      AND NEW.source_snapshot->>'stock_source_sha256'=j.source_sha256) THEN
    RAISE EXCEPTION 'Manufacturing sources require the immutable Stock capture transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_manufacturing_sources_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_manufacturing_sources FOR EACH ROW EXECUTE FUNCTION public.fn_stock_manufacturing_source_guard_995();
CREATE TRIGGER stock_manufacturing_sources_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_manufacturing_sources FOR EACH STATEMENT EXECUTE FUNCTION public.fn_stock_manufacturing_source_guard_995();

CREATE FUNCTION public.fn_stock_manufacturing_source_capture_995() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipts jsonb; operations jsonb; declarations jsonb; margin jsonb; snapshot jsonb;
  issues jsonb:='[]'::jsonb; reason text; receipt_count integer; operation_count integer;
  declaration_count integer; of_key text;
BEGIN
  IF NEW.source_snapshot->>'movement_type'<>'IN' OR NEW.source_snapshot->>'reversal_of_id' IS NOT NULL
    THEN RETURN NULL; END IF;
  SELECT reason_code INTO reason FROM public.stock_movements WHERE id=NEW.movement_id;
  IF reason IS DISTINCT FROM 'OF_RECEIPT'
    AND NOT EXISTS(SELECT 1 FROM public.of_receipts r WHERE r.stock_movement_id=NEW.movement_id)
    THEN RETURN NULL; END IF;
  -- Runs from the deferred Stock posting capture, after canonical receipt,
  -- quality and output-lot writes. No physical row is locked here.
  SELECT count(*)::integer,COALESCE(jsonb_agg(facts ORDER BY receipt_id),'[]'::jsonb)
    INTO receipt_count,receipts FROM (
    SELECT r.id AS receipt_id,jsonb_build_object(
      'id',r.id::text,'of_id',r.of_id::text,'stock_movement_id',r.stock_movement_id::text,
      'stock_level_id',r.stock_level_id::text,'stock_batch_id',r.stock_batch_id::text,
      'lot_id',r.lot_id::text,'quantity_good',r.qty_ok::text,'quantity_scrap',r.qty_scrap::text,
      'quantity_rework',r.qty_rework::text,'quality_status',r.quality_status,
      'non_conformity_id',r.non_conformity_id::text,'actor_user_id',r.actor_user_id,
      'request_hash',r.request_hash,'result_payload',r.result_payload,
      'of',CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object('id',o.id::text,'numero',o.numero,
        'article_id',o.article_id::text,'piece_technique_id',o.piece_technique_id::text,
        'piece_technique_version_id',o.piece_technique_version_id::text,'statut',o.statut::text,
        'quantity_good',o.quantite_bonne::text,'updated_at',o.updated_at::text) END,
      'lot',CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('id',l.id::text,
        'article_id',l.article_id::text,'owner_client_id',l.client_proprietaire_id,
        'lot_code',l.lot_code,'lot_status',l.lot_status::text) END) AS facts
    FROM public.of_receipts r LEFT JOIN public.ordres_fabrication o ON o.id=r.of_id
      LEFT JOIN public.lots l ON l.id=r.lot_id WHERE r.stock_movement_id=NEW.movement_id
    ORDER BY r.id LIMIT 2
  ) receipt_facts;
  IF receipt_count<>1 THEN issues:=issues||jsonb_build_array('MANUFACTURING_RECEIPT_CARDINALITY'); END IF;
  of_key:=CASE WHEN receipt_count=1 THEN receipts->0->>'of_id' ELSE NULL END;
  IF of_key IS NULL OR NEW.source_snapshot->>'source_document_type' IS DISTINCT FROM 'OF'
    OR NEW.source_snapshot->>'source_document_id' IS DISTINCT FROM of_key THEN
    issues:=issues||jsonb_build_array('MANUFACTURING_OF_SOURCE_MISMATCH'); END IF;
  IF receipt_count=1 AND(receipts->0->'of'='null'::jsonb OR receipts->0->'lot'='null'::jsonb) THEN
    issues:=issues||jsonb_build_array('MANUFACTURING_OF_OR_LOT_MISSING'); END IF;

  SELECT count(*)::integer,COALESCE(jsonb_agg(facts ORDER BY phase,id),'[]'::jsonb)
    INTO operation_count,operations FROM (
    SELECT op.id,op.phase,to_jsonb(op) AS facts FROM public.of_operations op
      WHERE op.of_id=of_key::bigint ORDER BY op.phase,op.id LIMIT 101
  ) operation_facts;
  SELECT count(*)::integer,COALESCE(jsonb_agg(facts ORDER BY declared_at,id),'[]'::jsonb)
    INTO declaration_count,declarations FROM (
    SELECT d.id,d.declared_at,to_jsonb(d) AS facts FROM public.production_quantity_declarations d
      WHERE d.of_id=of_key::bigint ORDER BY d.declared_at,d.id LIMIT 1001
  ) declaration_facts;
  IF operation_count>100 OR declaration_count>1000 THEN
    issues:=issues||jsonb_build_array('MANUFACTURING_OPERATION_EVIDENCE_TOO_DENSE'); END IF;

  SELECT CASE WHEN octet_length(m.input_snapshot::text)+octet_length(m.result_snapshot::text)<=524288
    THEN to_jsonb(m) ELSE to_jsonb(m)-'input_snapshot'-'result_snapshot'||jsonb_build_object('payload_omitted',true) END
    INTO margin FROM public.margin_recalculations m WHERE m.scope_type='OF' AND m.scope_ref=of_key AND m.basis='ACTUAL'
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1;
  IF margin IS NULL THEN issues:=issues||jsonb_build_array('MANUFACTURING_ACTUAL_MARGIN_SOURCE_MISSING');
  ELSIF margin->'payload_omitted'='true'::jsonb THEN issues:=issues||jsonb_build_array('MANUFACTURING_MARGIN_SOURCE_TOO_DENSE'); END IF;
  snapshot:=jsonb_build_object('schema_version',1,'movement_id',NEW.movement_id::text,
    'article_id',NEW.article_id::text,'stock_source_sha256',NEW.source_sha256,
    'stock_quantity',NEW.source_snapshot->>'quantity','stock_unit',NEW.source_snapshot->>'stock_unit',
    'receipts',receipts,'operations',operations,'quantity_declarations',declarations,'actual_margin',margin);
  IF octet_length(snapshot::text)>1048576 THEN
    snapshot:=snapshot||jsonb_build_object('operations','[]'::jsonb,'quantity_declarations','[]'::jsonb,
      'actual_margin',CASE WHEN margin IS NULL THEN NULL ELSE margin-'input_snapshot'-'result_snapshot'||jsonb_build_object('payload_omitted',true) END);
    issues:=issues||jsonb_build_array('MANUFACTURING_SOURCE_PAYLOAD_TOO_DENSE');
  END IF;
  INSERT INTO public.stock_valuation_manufacturing_sources(movement_id,posting_transaction,source_snapshot,source_sha256,source_issues)
  VALUES(NEW.movement_id,NEW.posting_transaction,snapshot,encode(digest(snapshot::text,'sha256'),'hex'),issues);
  RETURN NULL;
END $$;
CREATE TRIGGER stock_manufacturing_source_capture_995 AFTER INSERT ON public.stock_valuation_movement_journal
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_manufacturing_source_capture_995();
ALTER TABLE public.stock_valuation_manufacturing_boundary OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_manufacturing_sources OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_source_guard_995() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_manufacturing_source_capture_995() OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_manufacturing_sources IS
  'Future canonical OF receipt facts frozen in the Stock transaction. Saved margin is evidence, not a manufacturing valuation approval. No financial activation or historical reconstruction.';
COMMIT;
