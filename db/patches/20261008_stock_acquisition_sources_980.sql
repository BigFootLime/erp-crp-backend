-- Freeze purchase facts only for future receipt stock postings. No historical
-- price reconstruction and no CUMP activation. Receipt portions and the receipt
-- stock link describe the same movement; they are never summed together.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE public.stock_valuation_acquisition_boundary (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1)
);
INSERT INTO public.stock_valuation_acquisition_boundary(singleton) VALUES(true);
CREATE TRIGGER stock_acquisition_boundary_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_acquisition_boundary FOR EACH ROW
  EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();
CREATE TRIGGER stock_acquisition_boundary_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_acquisition_boundary FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_stock_valuation_boundary_guard_977();

CREATE TABLE public.stock_valuation_acquisition_sources (
  movement_id uuid PRIMARY KEY REFERENCES public.stock_valuation_movement_journal(movement_id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  posting_transaction text NOT NULL,
  source_snapshot jsonb NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source_issues jsonb NOT NULL CHECK(jsonb_typeof(source_issues)='array'),
  CHECK(jsonb_typeof(source_snapshot)='object'
    AND source_snapshot->>'schema_version'='1'
    AND (source_snapshot->>'movement_id') IS NOT DISTINCT FROM movement_id::text
    AND jsonb_typeof(source_snapshot->'receipts')='array'
    AND jsonb_typeof(source_snapshot->'portions')='array')
);

CREATE FUNCTION public.fn_stock_acquisition_guard_980() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'Stock acquisition sources are immutable' USING ERRCODE='23514';
  END IF;
  IF pg_trigger_depth()<3 OR NEW.posting_transaction<>pg_current_xact_id()::text
    OR NEW.source_sha256<>encode(digest(NEW.source_snapshot::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.stock_valuation_movement_journal j
      WHERE j.movement_id=NEW.movement_id AND j.posting_transaction=NEW.posting_transaction
        AND j.source_snapshot->>'movement_type'='IN'
        AND NEW.source_snapshot->>'stock_source_sha256'=j.source_sha256) THEN
    RAISE EXCEPTION 'Stock acquisition source requires the Stock capture transaction' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_acquisition_sources_immutable BEFORE INSERT OR UPDATE OR DELETE
  ON public.stock_valuation_acquisition_sources FOR EACH ROW
  EXECUTE FUNCTION public.fn_stock_acquisition_guard_980();
CREATE TRIGGER stock_acquisition_sources_truncate_guard BEFORE TRUNCATE
  ON public.stock_valuation_acquisition_sources FOR EACH STATEMENT
  EXECUTE FUNCTION public.fn_stock_acquisition_guard_980();

CREATE FUNCTION public.fn_stock_acquisition_capture_980() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb; receipts jsonb; portions jsonb; issues jsonb:='[]'::jsonb; receipt_count integer;
BEGIN
  IF NEW.source_snapshot->>'movement_type'<>'IN' THEN RETURN NULL; END IF;
  IF NEW.source_snapshot->>'source_document_type' IS DISTINCT FROM 'RECEPTION_FOURNISSEUR'
    AND NOT EXISTS(SELECT 1 FROM public.reception_fournisseur_stock_receipts s WHERE s.stock_movement_id=NEW.movement_id)
    AND NOT EXISTS(SELECT 1 FROM public.reception_stock_portions p WHERE p.stock_movement_id=NEW.movement_id)
    THEN RETURN NULL; END IF;

  -- The Stock journal is inserted by its deferred posting trigger. Both legacy
  -- and current receipt writers have completed all their links at this point.
  -- Prices are observed DECLARED facts, not approved invoice evidence. Reading
  -- them introduces no late purchase-row lock into the physical stock circuit.
  SELECT count(*)::integer,COALESCE(jsonb_agg(jsonb_build_object(
    'receipt_stock_id',s.id::text,'reception_id',s.reception_id::text,'receipt_line_id',s.reception_line_id::text,
    'receipt_quantity',s.qty::text,'line_reception_id',l.reception_id::text,
    'receipt_article_id',l.article_id::text,'stock_article_id',l.stock_article_id::text,
    'receipt_unit',l.unite,'stock_unit',l.stock_unit,'conversion_coefficient',l.stock_conversion_coef::text,
    'receipt_supplier_id',r.fournisseur_id::text,'receipt_order_id',r.commande_fournisseur_id::text,
    'order',CASE WHEN c.id IS NULL OR cl.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id',c.id::text,'line_id',cl.id::text,'article_id',cl.article_id::text,'status',c.statut,
      'line_status',cl.statut_ligne,'unit',cl.unite,'currency',c.devise,'quantity',cl.quantite::text,
      'unit_price',cl.prix_unitaire_ht::text,'discount_percent',cl.remise_pct::text,
      'additional_fees',cl.frais_ht::text,'transport_fees',c.frais_port_ht::text,
      'supplier_id',c.fournisseur_id::text,'document_version',c.version_document,
      'sent_at',c.date_envoi,'approved_at',c.approved_at,'line_updated_at',cl.updated_at
    ) END
  ) ORDER BY s.id),'[]'::jsonb) INTO receipt_count,receipts
  FROM public.reception_fournisseur_stock_receipts s
    LEFT JOIN public.reception_fournisseur_lignes l ON l.id=s.reception_line_id
    LEFT JOIN public.receptions_fournisseurs r ON r.id=s.reception_id
    LEFT JOIN public.commande_fournisseur_ligne cl ON cl.id=l.commande_fournisseur_ligne_id
    LEFT JOIN public.commande_fournisseur c ON c.id=cl.commande_id
  WHERE s.stock_movement_id=NEW.movement_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',p.id::text,'receipt_line_id',p.receipt_line_id::text,'packaging_id',p.packaging_id::text,
    'source_lot_id',p.source_lot_id::text,'stock_lot_id',p.stock_lot_id::text,
    'receipt_quantity',p.quantity::text,'stock_quantity',p.stock_quantity::text,
    'receipt_stock_offset',p.receipt_stock_offset::text
  ) ORDER BY p.id),'[]'::jsonb) INTO portions
    FROM public.reception_stock_portions p WHERE p.stock_movement_id=NEW.movement_id;
  IF receipt_count<>1 THEN issues:=issues||jsonb_build_array('RECEIPT_SOURCE_CARDINALITY'); END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(receipts) e WHERE e->'order'='null'::jsonb)
    THEN issues:=issues||jsonb_build_array('PURCHASE_ORDER_SOURCE_MISSING'); END IF;
  snapshot:=jsonb_build_object('schema_version',1,'movement_id',NEW.movement_id::text,
    'article_id',NEW.article_id::text,'stock_quantity',NEW.source_snapshot->>'quantity',
    'stock_unit',NEW.source_snapshot->>'stock_unit','owner_client_id',NEW.source_snapshot->>'batch_owner_client_id',
    'stock_source_sha256',NEW.source_sha256,'stock_lines',NEW.source_snapshot->'lines',
    'source_document_id',NEW.source_snapshot->>'source_document_id',
    'receipts',receipts,'portions',portions);
  INSERT INTO public.stock_valuation_acquisition_sources(movement_id,posting_transaction,source_snapshot,source_sha256,source_issues)
  VALUES(NEW.movement_id,NEW.posting_transaction,snapshot,encode(digest(snapshot::text,'sha256'),'hex'),issues);
  RETURN NULL;
END $$;
CREATE TRIGGER stock_acquisition_capture_980 AFTER INSERT ON public.stock_valuation_movement_journal
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_acquisition_capture_980();

ALTER TABLE public.stock_valuation_acquisition_boundary OWNER TO cerp_app;
ALTER TABLE public.stock_valuation_acquisition_sources OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_acquisition_guard_980() OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_acquisition_capture_980() OWNER TO cerp_app;
COMMENT ON TABLE public.stock_valuation_acquisition_sources IS
  'Immutable future receipt purchase facts, captured in the Stock posting transaction. DECLARED evidence only; no CUMP projection, invoice approval or historical price reconstruction.';
COMMIT;
