-- Read-only. Run on the target before scheduling the additive migration.
BEGIN READ ONLY;
DO $$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['articles','clients','receptions_fournisseurs','reception_fournisseur_lignes','quality_control','quality_release_decision','of_material_receipt_transfers','subcontract_work_packages','subcontract_work_package_ledger','gestion_outils_outil','gestion_outils_stock','gestion_outils_mouvement_stock'] LOOP
    IF to_regclass('public.'||name) IS NULL THEN RAISE EXCEPTION 'Missing prerequisite: %',name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_app') THEN RAISE EXCEPTION 'cerp_app role required'; END IF;
  -- Only the open piece receipts promoted by this migration need a valid
  -- frozen conversion. Historical STANDARD receipts retain their existing
  -- reconciliation path; this preflight must not invent their unit snapshots.
  IF EXISTS(
    SELECT 1 FROM public.reception_fournisseur_lignes l
    JOIN public.receptions_fournisseurs r ON r.id=l.reception_id
    JOIN public.articles a ON a.id=l.article_id
    LEFT JOIN public.commande_fournisseur_ligne c ON c.id=l.commande_fournisseur_ligne_id
    WHERE r.status='OPEN'
      AND (a.article_category IN ('achat','fabrique') OR c.type='SOUS_TRAITANCE'
        OR EXISTS(SELECT 1 FROM public.article_category_link t WHERE t.article_id=a.id
          AND t.category_code IN ('piece_finie_fabriquee','sous_traitance','achat_revente')))
      AND NOT EXISTS(SELECT 1 FROM public.article_category_link t WHERE t.article_id=a.id AND t.category_code='consommable')
      AND (l.stock_unit IS NULL OR l.stock_conversion_coef IS NULL OR l.stock_conversion_coef<=0)
  ) THEN
    RAISE EXCEPTION 'Receipt unit snapshots must be reconciled before #1069';
  END IF;
END $$;
SELECT r.id,r.reception_no,l.id AS line_id,l.article_id,a.article_category,l.qty_received,
 COALESCE((SELECT sum(s.qty) FROM public.reception_fournisseur_stock_receipts s JOIN public.stock_movements m ON m.id=s.stock_movement_id AND m.status='POSTED' WHERE s.reception_line_id=l.id),0) AS historically_stocked
FROM public.receptions_fournisseurs r JOIN public.reception_fournisseur_lignes l ON l.reception_id=r.id
JOIN public.articles a ON a.id=l.article_id
WHERE r.status='OPEN' AND (a.article_category IN('achat','fabrique') OR EXISTS(SELECT 1 FROM public.commande_fournisseur_ligne c WHERE c.id=l.commande_fournisseur_ligne_id AND c.type='SOUS_TRAITANCE')
 OR EXISTS(SELECT 1 FROM public.article_category_link c WHERE c.article_id=a.id AND c.category_code IN('piece_finie_fabriquee','sous_traitance','achat_revente')))
 AND NOT EXISTS(SELECT 1 FROM public.article_category_link c WHERE c.article_id=a.id AND c.category_code='consommable')
ORDER BY r.reception_no,l.line_no;
COMMIT;
