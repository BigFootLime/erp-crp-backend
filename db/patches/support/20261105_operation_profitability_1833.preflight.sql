SELECT count(*) AS operations_before FROM public.pieces_techniques_operations;
SELECT count(*) AS frozen_orders_before FROM public.ordres_fabrication WHERE technical_snapshot_sha256 IS NOT NULL;
