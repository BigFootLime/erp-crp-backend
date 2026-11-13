-- Future receipt evidence only; keep #980 tables, immutable proofs and old capture function.
-- One statement snapshot freezes all active monetary lines; no late purchase-row lock.
BEGIN;
SET LOCAL lock_timeout='10s';
LOCK TABLE public.stock_movements IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION public.fn_stock_order_transport_basis_1016(order_id uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $transport$
  SELECT jsonb_build_object('schema_version',1,'method','PROPORTIONAL_NET_V1',
    'order_id',c.id::text,'supplier_id',c.fournisseur_id::text,'currency',upper(btrim(c.devise)),
    'transport_fees',c.frais_port_ht::text,'active_line_count',COALESCE(b.active_count,0),
    'lines_complete',COALESCE(b.active_count BETWEEN 1 AND 500,false),'lines',COALESCE(b.lines,'[]'::jsonb))
  FROM public.commande_fournisseur c
  LEFT JOIN LATERAL (
    SELECT max(total_count)::integer AS active_count,
      jsonb_agg(jsonb_build_object('line_id',l.id::text,'article_id',l.article_id::text,'unit',l.unite,
        'quantity',l.quantite::text,'unit_price',l.prix_unitaire_ht::text,
        'discount_percent',l.remise_pct::text,'additional_fees',l.frais_ht::text) ORDER BY l.id) AS lines
    FROM (SELECT cl.*,count(*) OVER() AS total_count FROM public.commande_fournisseur_ligne cl
      WHERE cl.commande_id=c.id AND cl.statut_ligne='ACTIVE' ORDER BY cl.id LIMIT 501) l
  ) b ON true WHERE c.id=order_id
$transport$;

CREATE FUNCTION public.fn_stock_acquisition_capture_1016() RETURNS trigger LANGUAGE plpgsql AS $$
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
      'transport_basis',CASE WHEN c.frais_port_ht>0 THEN public.fn_stock_order_transport_basis_1016(c.id) ELSE NULL END,
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
DROP TRIGGER stock_acquisition_capture_980 ON public.stock_valuation_movement_journal;
CREATE TRIGGER stock_acquisition_capture_980 AFTER INSERT ON public.stock_valuation_movement_journal
  FOR EACH ROW EXECUTE FUNCTION public.fn_stock_acquisition_capture_1016();
ALTER FUNCTION public.fn_stock_order_transport_basis_1016(uuid) OWNER TO cerp_app;
ALTER FUNCTION public.fn_stock_acquisition_capture_1016() OWNER TO cerp_app;
COMMENT ON FUNCTION public.fn_stock_order_transport_basis_1016(uuid) IS
  'Future declared purchase transport basis, complete active order lines bounded at 500; no invoice approval or historical reconstruction.';
COMMIT;
