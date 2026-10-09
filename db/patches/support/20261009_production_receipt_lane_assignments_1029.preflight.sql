BEGIN READ ONLY;
SELECT to_regclass('public.of_receipts') AS receipts,to_regclass('public.stock_lane_locations') AS lanes,
  to_regclass('public.delivery_promise_parts') AS promises;
-- Existing receipts are deliberately outside automatic attribution activation.
SELECT quality_status,count(*) FROM public.of_receipts GROUP BY quality_status;
COMMIT;
