DO $$ BEGIN
  IF NOT has_table_privilege('cerp_app','public.v_technical_stock_compatibility_832','SELECT') THEN
    RAISE EXCEPTION 'Stock compatibility application grant missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.v_technical_stock_compatibility_832 forward
    LEFT JOIN public.v_technical_stock_compatibility_832 reverse
      ON reverse.target_version_id=forward.stock_version_id AND reverse.stock_version_id=forward.target_version_id
    WHERE reverse.target_version_id IS NULL
  ) THEN RAISE EXCEPTION 'Approved minor compatibility is asymmetric'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.v_technical_stock_compatibility_832 compatibility
    JOIN public.piece_technique_versions stock ON stock.id=compatibility.stock_version_id
    JOIN public.piece_technique_versions target ON target.id=compatibility.target_version_id
    WHERE stock.piece_technique_id IS DISTINCT FROM target.piece_technique_id
      OR upper(btrim(stock.indice)) IS DISTINCT FROM upper(btrim(target.indice))
      OR stock.statut NOT IN ('APPLICABLE','OBSOLETE') OR target.statut NOT IN ('APPLICABLE','OBSOLETE')
  ) THEN RAISE EXCEPTION 'Stock compatibility crossed an unapproved identity'; END IF;
  IF EXISTS (SELECT 1 FROM public.v_technical_stock_compatibility_832
    GROUP BY target_version_id,stock_version_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Stock compatibility contains duplicate pairs';
  END IF;
END $$;
SELECT target_version_id,stock_version_id FROM public.v_technical_stock_compatibility_832 LIMIT 0;
