-- #1428: complete only unambiguous existing magasin/warehouse mappings.
-- No warehouse, location, stock quantity or physical movement is invented.
BEGIN;
SET LOCAL lock_timeout='5s';
UPDATE public.magasins m
SET warehouse_id=w.id,updated_at=now()
FROM public.warehouses w
WHERE m.warehouse_id IS NULL AND w.code::text=COALESCE(m.code,m.code_magasin)
  AND NOT EXISTS (
    SELECT 1 FROM public.emplacements e JOIN public.locations l ON l.id=e.location_id
    WHERE e.magasin_id=m.id AND l.warehouse_id IS DISTINCT FROM w.id
  );
COMMIT;
