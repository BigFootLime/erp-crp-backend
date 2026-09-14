BEGIN READ ONLY;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.receipt_processing_overview_1069 WHERE NOT reconciliation_required AND (stocked>packed OR packed>accepted OR accepted>received)) THEN
    RAISE EXCEPTION 'Receipt quantity chain requires review';
  END IF;
  IF EXISTS(SELECT 1 FROM public.reception_stock_portions p JOIN public.lots lot ON lot.id=p.stock_lot_id JOIN public.articles a ON a.id=lot.article_id JOIN public.reception_fournisseur_lignes r ON r.id=p.receipt_line_id WHERE a.article_category<>'matiere' OR a.id<>r.stock_article_id) THEN
    RAISE EXCEPTION 'Stock portion destination differs from the mapped MP article';
  END IF;
  IF EXISTS(SELECT 1 FROM public.articles a WHERE
      (a.commercial_scope='CRP' AND (NULLIF(trim(a.internal_reference),'') IS NULL OR EXISTS(SELECT 1 FROM public.article_client_links c WHERE c.article_id=a.id)))
      OR (a.commercial_scope='CLIENTS' AND NOT EXISTS(SELECT 1 FROM public.article_client_links c WHERE c.article_id=a.id))) THEN
    RAISE EXCEPTION 'Article commercial choice is inconsistent';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='stock_piece_entry_1069' AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='stock_piece_line_1069' AND tgenabled='O') THEN
    RAISE EXCEPTION 'Mandatory stock guards are not enabled';
  END IF;
END $$;
-- Evidence/recovery worklist. These rows are not silently declared compliant.
SELECT v.*,CASE WHEN stocked>0 THEN 'HISTORICAL_STOCK_REVIEW' ELSE 'EXPLICIT_RECONCILIATION' END AS action
FROM public.receipt_processing_overview_1069 v WHERE reconciliation_required ORDER BY reception_date,id;
SELECT id,code,designation FROM public.articles WHERE article_category='fabrique' AND commercial_scope IS NULL ORDER BY code;
COMMIT;
