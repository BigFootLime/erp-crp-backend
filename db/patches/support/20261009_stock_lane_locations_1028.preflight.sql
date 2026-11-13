-- Read-only prerequisites and physical topology inventory; no implicit classification.
BEGIN READ ONLY;
SELECT to_regclass('public.v_stock_availability_225') AS canonical_stock,
  to_regclass('public.of_component_requirements') AS component_requirements,
  to_regprocedure('public.fn_protect_stock_immutable_evidence()') AS evidence_protection;
SELECT m.code AS magasin,e.code AS emplacement,e.location_id,e.location_type,
  e.is_active,e.allow_inbound,e.allow_outbound,
  EXISTS(SELECT 1 FROM public.stock_levels sl WHERE sl.location_id=e.location_id
    AND (sl.qty_total<>0 OR sl.qty_reserved<>0)) AS contains_stock
FROM public.emplacements e JOIN public.magasins m ON m.id=e.magasin_id
ORDER BY m.code,e.code,e.id;
COMMIT;
