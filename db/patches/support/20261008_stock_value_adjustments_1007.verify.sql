DO $$
DECLARE
  invoice_successor boolean;
  posting_name text;
  posting_columns text[];
BEGIN
  IF to_regclass('public.stock_valuation_value_adjustments') IS NULL
    OR to_regprocedure('public.fn_stock_value_candidate_1007(uuid,text)') IS NULL
    OR to_regprocedure('public.fn_stock_value_physical_1007(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'Documented current-value structures are missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.stock_valuation_value_adjustments'::regclass
      AND NOT tgisinternal AND tgenabled='O')<>3
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock_valuation_value_adjustments'::regclass
      AND tgname='stock_value_adjustment_commit_guard' AND tgdeferrable AND tginitdeferred AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.stock_valuation_entries'::regclass
      AND tgname='stock_value_adjustment_entry_guard' AND NOT tgisinternal AND tgenabled='O') THEN
    RAISE EXCEPTION 'Financial approval/entry/commit guards are missing';
  END IF;
  -- #1022 extends the same NULLS NOT DISTINCT key with the invoice correction
  -- UUID. Physical/opening postings still have both correction UUIDs NULL.
  -- The documented #1022 shape rollback retains archive tables/columns but
  -- restores the #1007 kind/key. Inspect the active kind contract instead.
  invoice_successor := EXISTS(SELECT 1 FROM pg_constraint
    WHERE conrelid='public.stock_valuation_entries'::regclass
      AND conname='stock_invoice_entry_kind_1022' AND contype='c' AND convalidated);
  posting_name := CASE WHEN invoice_successor THEN 'stock_invoice_posting_unique_1022'
    ELSE 'stock_value_posting_unique_1007' END;
  posting_columns := ARRAY['movement_id','article_id','owner_key','stock_unit','currency','value_adjustment_id'];
  IF invoice_successor THEN posting_columns := posting_columns || 'invoice_reconciliation_id'::text; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
    WHERE c.conrelid='public.stock_valuation_entries'::regclass AND c.conname=posting_name
      AND c.contype='u' AND c.convalidated AND i.indisvalid AND i.indisready AND i.indnullsnotdistinct
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality)
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=posting_columns) THEN
    RAISE EXCEPTION 'Physical/opening uniqueness must remain preserved alongside correction UUIDs';
  END IF;
  IF invoice_successor AND NOT EXISTS(SELECT 1 FROM pg_constraint c
    WHERE c.conrelid='public.stock_valuation_entries'::regclass
      AND c.conname='stock_invoice_entry_identity_1022' AND c.contype='c' AND c.convalidated
      AND regexp_replace(pg_get_expr(c.conbin,c.conrelid),'[()[:space:]]','','g')=
        'kind=''INVOICE_ADJUSTMENT''::text=invoice_reconciliation_idISNOTNULL') THEN
    RAISE EXCEPTION 'Physical/opening uniqueness requires the validated invoice correction identity';
  END IF;
  IF EXISTS(SELECT 1 FROM public.stock_valuation_value_adjustments
    WHERE source_sha256<>encode(digest(source_snapshot::text,'sha256'),'hex') OR source_reliability<>'DECLARED') THEN
    RAISE EXCEPTION 'Financial declaration proof invalid';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.stock_valuation_projector_control
    WHERE singleton AND mode='PREPARED' AND NOT initialized AND last_sequence=0 AND reporting_currency='EUR') THEN
    RAISE EXCEPTION 'Delivery changed the prepared Stock projector';
  END IF;
END $$;
