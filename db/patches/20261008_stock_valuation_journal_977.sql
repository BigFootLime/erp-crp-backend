-- Capture future physical postings under the Stock owner, including legacy
-- writers which insert POSTED headers before their lines. This is an immutable
-- source journal, not an activated CUMP projection. No history is reconstructed.
BEGIN;
SET LOCAL lock_timeout='10s';
-- Wait for preceding posting transactions to finish and hold future postings
-- until opening quantities and capture triggers commit together. Reading the
-- levels needs no row lock and cannot invert the application's level locks.
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.stock_valuation_capture_boundary (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  mode text NOT NULL DEFAULT 'CAPTURE_ONLY' CHECK(mode='CAPTURE_ONLY'),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1)
);
INSERT INTO public.stock_valuation_capture_boundary(singleton) VALUES(true);

CREATE TABLE public.stock_valuation_opening_quantities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_level_id uuid NOT NULL,
  stock_batch_id uuid,
  article_id uuid NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_snapshot jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot)='object'),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  UNIQUE NULLS NOT DISTINCT(stock_level_id,stock_batch_id)
);
-- Keep LEVEL and BATCH observations separately. They are not additive: a level
-- already contains its batches. The later owner resolver must reconcile both.
-- Neither an old catalogue price nor the last order values these openings.
WITH openings AS (
  SELECT s.id AS level_id,NULL::uuid AS batch_id,s.article_id,
    jsonb_build_object('schema_version',1,'kind','LEVEL','article_id',s.article_id::text,
      'stock_level_id',s.id::text,'stock_batch_id',NULL,'stock_unit',COALESCE(u.code,a.unite),
      'quantity_total',s.qty_total::text,'quantity_depreciated',s.qty_depreciated::text,
      'quantity_reserved',s.qty_reserved::text,'owner_client_id',NULL) AS snapshot
  FROM public.stock_levels s JOIN public.articles a ON a.id=s.article_id LEFT JOIN public.units u ON u.id=s.unit_id
  UNION ALL
  SELECT s.id,b.id,s.article_id,
    jsonb_build_object('schema_version',1,'kind','BATCH','article_id',s.article_id::text,
      'stock_level_id',s.id::text,'stock_batch_id',b.id::text,'stock_unit',COALESCE(u.code,a.unite),
      'quantity_total',b.qty_total::text,'quantity_depreciated',b.qty_depreciated::text,
      'quantity_reserved',b.qty_reserved::text,'lot_id',b.lot_id::text,'owner_client_id',l.client_proprietaire_id)
  FROM public.stock_batches b JOIN public.stock_levels s ON s.id=b.stock_level_id
    JOIN public.articles a ON a.id=s.article_id LEFT JOIN public.units u ON u.id=s.unit_id LEFT JOIN public.lots l ON l.id=b.lot_id
)
INSERT INTO public.stock_valuation_opening_quantities(stock_level_id,stock_batch_id,article_id,source_snapshot,source_sha256)
SELECT level_id,batch_id,article_id,snapshot,encode(digest(snapshot::text,'sha256'),'hex') FROM openings;

CREATE TABLE public.stock_valuation_movement_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  movement_id uuid NOT NULL UNIQUE REFERENCES public.stock_movements(id) ON DELETE RESTRICT,
  article_id uuid NOT NULL REFERENCES public.articles(id) ON DELETE RESTRICT,
  posted_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  posting_transaction text NOT NULL,
  captured_by integer,
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  capture_status text NOT NULL CHECK(capture_status IN('PENDING_VALUATION','SOURCE_INCOMPLETE')),
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_issues jsonb NOT NULL CHECK(jsonb_typeof(source_issues)='array'),
  CHECK(jsonb_typeof(source_snapshot)='object'
    AND jsonb_typeof(source_snapshot->'lines')='array'
    AND (source_snapshot->>'movement_id') IS NOT DISTINCT FROM movement_id::text
    AND (source_snapshot->>'article_id') IS NOT DISTINCT FROM article_id::text
    AND (source_snapshot->>'schema_version') IS NOT DISTINCT FROM schema_version::text)
);
CREATE INDEX stock_valuation_journal_article_sequence_idx
  ON public.stock_valuation_movement_journal(article_id,sequence DESC);

CREATE FUNCTION public.fn_stock_valuation_journal_guard_977() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Stock valuation source journals are immutable' USING ERRCODE='23514';
  END IF;
  -- A form or an ordinary INSERT must never manufacture a valuation proof.
  -- Only the deferred Stock posting trigger constructs this source snapshot.
  IF pg_trigger_depth()<2 OR NEW.posting_transaction<>pg_current_xact_id()::text
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.stock_movements m
      WHERE m.id=NEW.movement_id AND m.article_id=NEW.article_id
        AND m.status::text IN('POSTED','COMPENSATED')
        AND m.posted_at IS NOT DISTINCT FROM NEW.posted_at
        AND m.posted_by IS NOT DISTINCT FROM NEW.captured_by) THEN
    RAISE EXCEPTION 'Stock valuation journal requires its posting transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_valuation_journal_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_movement_journal FOR EACH ROW
  EXECUTE FUNCTION public.fn_stock_valuation_journal_guard_977();
CREATE TRIGGER stock_valuation_journal_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_movement_journal FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_stock_valuation_journal_guard_977();

CREATE FUNCTION public.fn_stock_valuation_boundary_guard_977() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Stock valuation capture boundary is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER stock_valuation_boundary_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_capture_boundary FOR EACH ROW
  EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();
CREATE TRIGGER stock_valuation_opening_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_opening_quantities FOR EACH ROW
  EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();
CREATE TRIGGER stock_valuation_boundary_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_capture_boundary FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();
CREATE TRIGGER stock_valuation_opening_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_opening_quantities FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();

CREATE FUNCTION public.fn_stock_valuation_posting_capture_977() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m public.stock_movements%ROWTYPE;
  snapshot jsonb;
  captured_lines jsonb;
  issues jsonb:='[]'::jsonb;
  line_count integer;
  line_qty numeric;
  stock_unit text;
  batch_owner text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=NEW.id) THEN RETURN NULL; END IF;
  SELECT * INTO STRICT m FROM public.stock_movements WHERE id=NEW.id;
  -- Cancellation/compensation does not undo the original physical posting.
  -- Its inverse is a separate posting, captured with reversal_of_id preserved.
  IF m.status::text NOT IN('POSTED','COMPENSATED') OR m.posted_at IS NULL THEN
    RAISE EXCEPTION 'Stock posting lost its valuation capture source' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(u.code,a.unite),l.client_proprietaire_id
    INTO stock_unit,batch_owner
    FROM public.stock_levels s JOIN public.articles a ON a.id=s.article_id
    LEFT JOIN public.units u ON u.id=s.unit_id
    LEFT JOIN public.stock_batches b ON b.id=m.stock_batch_id
    LEFT JOIN public.lots l ON l.id=b.lot_id WHERE s.id=m.stock_level_id;

  SELECT count(*)::integer,sum(abs(ml.qty)),COALESCE(jsonb_agg(jsonb_build_object(
    'line_id',ml.id::text,'line_no',ml.line_no,'article_id',ml.article_id::text,
    'lot_id',ml.lot_id::text,'quantity',ml.qty::text,'unit',ml.unite,
    'unit_cost',ml.unit_cost::text,'currency',ml.currency,'direction',ml.direction,
    'owner_client_id',l.client_proprietaire_id,
    'source_warehouse_id',ml.src_magasin_id::text,'source_location_id',ml.src_emplacement_id::text,
    'destination_warehouse_id',ml.dst_magasin_id::text,'destination_location_id',ml.dst_emplacement_id::text
  ) ORDER BY ml.line_no,ml.id),'[]'::jsonb)
    INTO line_count,line_qty,captured_lines
    FROM public.stock_movement_lines ml LEFT JOIN public.lots l ON l.id=ml.lot_id WHERE ml.movement_id=m.id;
  IF line_count=0 THEN issues:=issues||jsonb_build_array('MOVEMENT_LINES_MISSING'); END IF;
  IF line_qty IS DISTINCT FROM abs(m.qty) THEN issues:=issues||jsonb_build_array('HEADER_LINE_QUANTITY_MISMATCH'); END IF;
  IF NULLIF(btrim(stock_unit),'') IS NULL THEN issues:=issues||jsonb_build_array('STOCK_UNIT_MISSING'); END IF;
  IF EXISTS(SELECT 1 FROM public.stock_movement_lines ml WHERE ml.movement_id=m.id AND ml.article_id<>m.article_id)
    THEN issues:=issues||jsonb_build_array('ARTICLE_SCOPE_MISMATCH'); END IF;
  -- Raw monetary evidence remains DECLARED input for the later resolver. The
  -- journal never labels a free movement price or catalogue price VERIFIED.
  snapshot:=jsonb_build_object(
    'schema_version',1,'movement_id',m.id::text,'article_id',m.article_id::text,
    'movement_type',m.movement_type::text,'movement_no',m.movement_no,
    'quantity',m.qty::text,'stock_unit',stock_unit,'stock_level_id',m.stock_level_id::text,
    'stock_batch_id',m.stock_batch_id::text,'batch_owner_client_id',batch_owner,
    'currency',m.currency,'effective_at',m.effective_at,'posted_at',m.posted_at,
    'source_document_type',m.source_document_type,'source_document_id',m.source_document_id,
    'document_type',m.doc_type,'document_id',m.doc_id::text,'reversal_of_id',m.reversal_of_id::text,
    'posted_by',m.posted_by,'lines',captured_lines);
  INSERT INTO public.stock_valuation_movement_journal(
    movement_id,article_id,posted_at,posting_transaction,captured_by,
    capture_status,source_snapshot,source_sha256,source_issues)
  VALUES(m.id,m.article_id,m.posted_at,pg_current_xact_id()::text,m.posted_by,
    CASE WHEN jsonb_array_length(issues)=0 THEN 'PENDING_VALUATION' ELSE 'SOURCE_INCOMPLETE' END,
    snapshot,encode(digest(snapshot::text,'sha256'),'hex'),issues);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER stock_valuation_posting_insert_977 AFTER INSERT ON public.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN(NEW.status::text='POSTED' AND NEW.movement_type::text IN('IN','OUT','SCRAP','DEPRECIATE','ADJUST','ADJUSTMENT','TRANSFER'))
  EXECUTE FUNCTION public.fn_stock_valuation_posting_capture_977();
CREATE CONSTRAINT TRIGGER stock_valuation_posting_update_977 AFTER UPDATE OF status ON public.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN(NEW.status::text='POSTED' AND OLD.status::text IS DISTINCT FROM 'POSTED'
    AND NEW.movement_type::text IN('IN','OUT','SCRAP','DEPRECIATE','ADJUST','ADJUSTMENT','TRANSFER'))
  EXECUTE FUNCTION public.fn_stock_valuation_posting_capture_977();

-- Serialize every line mutation with its header. A concurrent edit that saw
-- DRAFT before the posting committed must recheck the journal after the lock.
-- The current posting transaction may still insert lines before deferred capture.
CREATE FUNCTION public.fn_stock_valuation_posted_line_guard_977() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_ids uuid[];
BEGIN
  IF TG_OP='DELETE' THEN movement_ids:=ARRAY[OLD.movement_id];
  ELSIF TG_OP='UPDATE' THEN movement_ids:=ARRAY[OLD.movement_id,NEW.movement_id];
  ELSE movement_ids:=ARRAY[NEW.movement_id]; END IF;
  PERFORM m.id FROM public.stock_movements m WHERE m.id=ANY(movement_ids) ORDER BY m.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j WHERE j.movement_id=ANY(movement_ids)) THEN
    RAISE EXCEPTION 'Cannot change lines of a captured stock posting' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_valuation_posted_line_mutation_977 BEFORE INSERT OR UPDATE OR DELETE ON public.stock_movement_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_valuation_posted_line_guard_977();

ALTER TABLE public.stock_valuation_capture_boundary OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_opening_quantities OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_movement_journal OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_journal_guard_977() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_boundary_guard_977() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_posting_capture_977() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_valuation_posted_line_guard_977() OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_movement_journal IS
  'Immutable future posting source capture. PENDING_VALUATION is not a CUMP or a verified cost. Sequence is capture order, not business effective date.';
COMMIT;
