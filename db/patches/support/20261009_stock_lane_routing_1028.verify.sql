BEGIN READ ONLY;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.stock_lane_destinations destination
    LEFT JOIN public.stock_lane_locations role ON role.location_id=destination.location_id
    WHERE role.lane IS DISTINCT FROM destination.lane) THEN
    RAISE EXCEPTION 'STOCK_LANE_DESTINATION_ROLE_MISMATCH';
  END IF;
  IF EXISTS(SELECT 1 FROM public.of_receipts receipt
    JOIN (SELECT receipt_id,sum(quantity) AS quantity FROM public.production_receipt_lane_routes GROUP BY receipt_id) routed
      ON routed.receipt_id=receipt.id
    LEFT JOIN (SELECT receipt_id,sum(quantity) AS quantity FROM public.production_receipt_lane_assignments GROUP BY receipt_id) assigned
      ON assigned.receipt_id=receipt.id
    WHERE routed.quantity>receipt.qty_ok OR routed.quantity>COALESCE(assigned.quantity,0)) THEN
    RAISE EXCEPTION 'PRODUCTION_RECEIPT_ROUTE_QUANTITY_EXCEEDED';
  END IF;
  IF EXISTS(SELECT 1 FROM public.production_receipt_lane_routes route
    CROSS JOIN LATERAL (SELECT sum((item->>'quantity')::numeric) AS quantity FROM jsonb_array_elements(route.destinations) item) total
    WHERE total.quantity IS DISTINCT FROM route.quantity) THEN
    RAISE EXCEPTION 'PRODUCTION_RECEIPT_ROUTE_DESTINATION_QUANTITY_MISMATCH';
  END IF;
  IF EXISTS(SELECT 1 FROM public.production_receipt_lane_routes route
    CROSS JOIN LATERAL jsonb_array_elements(route.destinations) destination
    LEFT JOIN public.stock_movements movement ON movement.id=(destination->>'movement_id')::uuid
    WHERE destination->>'movement_id' IS NOT NULL AND (movement.id IS NULL OR movement.status<>'POSTED'
      OR movement.movement_type<>'TRANSFER' OR abs(movement.qty)<>(destination->>'quantity')::numeric)) THEN
    RAISE EXCEPTION 'PRODUCTION_RECEIPT_ROUTE_TRANSFER_PROOF_MISMATCH';
  END IF;
END $$;
SELECT lane,location_id FROM public.stock_lane_destinations ORDER BY lane;
-- Must return zero rows: defaults must retain their configured physical role.
SELECT destination.lane,destination.location_id FROM public.stock_lane_destinations destination
  LEFT JOIN public.stock_lane_locations role ON role.location_id=destination.location_id
  WHERE role.lane IS DISTINCT FROM destination.lane;
-- Must return zero rows: physical routing cannot exceed actual received output or its assignments.
SELECT receipt.id FROM public.of_receipts receipt
  JOIN (SELECT receipt_id,sum(quantity) AS quantity FROM public.production_receipt_lane_routes GROUP BY receipt_id) routed
    ON routed.receipt_id=receipt.id
  LEFT JOIN (SELECT receipt_id,sum(quantity) AS quantity FROM public.production_receipt_lane_assignments GROUP BY receipt_id) assigned
    ON assigned.receipt_id=receipt.id
  WHERE routed.quantity>receipt.qty_ok OR routed.quantity>COALESCE(assigned.quantity,0);
SELECT route.id FROM public.production_receipt_lane_routes route
  CROSS JOIN LATERAL (SELECT sum((item->>'quantity')::numeric) AS quantity FROM jsonb_array_elements(route.destinations) item) total
  WHERE total.quantity IS DISTINCT FROM route.quantity;
-- Must return zero rows: a transfer proof must reference the posted canonical parent movement.
SELECT route.id FROM public.production_receipt_lane_routes route
  CROSS JOIN LATERAL jsonb_array_elements(route.destinations) destination
  LEFT JOIN public.stock_movements movement ON movement.id=(destination->>'movement_id')::uuid
  WHERE destination->>'movement_id' IS NOT NULL AND (movement.id IS NULL OR movement.status<>'POSTED'
    OR movement.movement_type<>'TRANSFER' OR abs(movement.qty)<>(destination->>'quantity')::numeric);
ROLLBACK;
