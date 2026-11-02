\set ON_ERROR_STOP on
DO $$ BEGIN
 IF to_regclass('public.carco_reviews') IS NULL OR to_regclass('public.carco_submitted_lines') IS NULL
    OR to_regclass('public.commande_document_pdf_content') IS NULL THEN RAISE EXCEPTION 'Missing CARCO review schema'; END IF;
 IF EXISTS (SELECT 1 FROM public.commande_client_workflow_checkpoint cp
  JOIN LATERAL (SELECT nouveau_statut FROM public.commande_historique h WHERE h.commande_id=cp.commande_id ORDER BY date_action DESC,id DESC LIMIT 1) st ON true
  WHERE st.nouveau_statut='ANNULE' AND cp.status IN ('active','pending','blocked')) THEN
  RAISE EXCEPTION 'An inactive order still has an active checkpoint'; END IF;
END $$;
