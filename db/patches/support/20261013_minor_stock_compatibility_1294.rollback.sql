-- Reviewed semantic rollback only; preserve reservations, documents and the ledger.
CREATE OR REPLACE VIEW public.v_technical_stock_compatibility_832 AS
WITH RECURSIVE compatible(target_version_id,stock_version_id,path) AS (
 SELECT id,id,ARRAY[id] FROM public.piece_technique_versions
 UNION ALL
 SELECT c.target_version_id,source.id,c.path||source.id FROM compatible c
 JOIN public.piece_technique_versions current ON current.id=c.stock_version_id
 JOIN public.piece_technique_versions source ON source.id=current.copied_from_version_id
 WHERE current.change_level='MINOR' AND current.impact_interchangeabilite=false
 AND current.statut IN('APPLICABLE','OBSOLETE') AND source.statut IN('APPLICABLE','OBSOLETE')
 AND current.piece_technique_id=source.piece_technique_id
 AND upper(btrim(current.indice))=upper(btrim(source.indice)) AND NOT source.id=ANY(c.path)
) SELECT target_version_id,stock_version_id FROM compatible;
GRANT SELECT ON public.v_technical_stock_compatibility_832 TO cerp_app;
