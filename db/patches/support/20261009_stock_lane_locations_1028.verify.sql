BEGIN READ ONLY;
SELECT to_regclass('public.stock_lane_locations') AS locations,
  to_regclass('public.stock_lane_configuration_events') AS events,
  to_regclass('public.v_stock_lane_positions_1028') AS positions;
-- Expected: no rows. A lane projection must have exactly the canonical positions.
SELECT availability_id FROM public.v_stock_availability_225
WHERE qty_on_hand<>0 OR qty_reserved<>0
EXCEPT SELECT position_id FROM public.v_stock_lane_positions_1028;
SELECT position_id FROM public.v_stock_lane_positions_1028
GROUP BY position_id HAVING count(*)<>1;
-- Expected: no rows. Compare per position, never sum incompatible article units.
SELECT p.position_id FROM public.v_stock_lane_positions_1028 p
JOIN public.v_stock_availability_225 a ON a.availability_id=p.position_id
WHERE p.physical_qty IS DISTINCT FROM a.qty_on_hand
  OR p.reserved_qty IS DISTINCT FROM a.qty_reserved;
-- Reconciliation facts; existing mismatches are reported, not repaired automatically.
SELECT position_id,article_code,lot_code,reserved_qty,unexplained_reserved_qty
FROM public.v_stock_lane_positions_1028 WHERE unexplained_reserved_qty<>0;
COMMIT;
