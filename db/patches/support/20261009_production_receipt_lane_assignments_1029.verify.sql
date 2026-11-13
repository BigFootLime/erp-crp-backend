BEGIN READ ONLY;
-- Each query must return zero rows. No balance is automatically repaired.
SELECT receipt.id,receipt.qty_ok,sum(a.quantity) AS attributed
FROM public.of_receipts receipt JOIN public.production_receipt_lane_assignments a ON a.receipt_id=receipt.id
GROUP BY receipt.id HAVING sum(a.quantity)>receipt.qty_ok;
SELECT assignment.id,assignment.quantity,parts.quantity AS distributed
FROM public.production_receipt_lane_assignments assignment
CROSS JOIN LATERAL (SELECT sum((destination->>'quantity')::numeric) AS quantity
  FROM jsonb_array_elements(assignment.distribution->'destinations') destination) parts
WHERE assignment.quantity IS DISTINCT FROM parts.quantity
  OR assignment.quantity IS DISTINCT FROM (assignment.distribution->>'received_quantity')::numeric;
COMMIT;
