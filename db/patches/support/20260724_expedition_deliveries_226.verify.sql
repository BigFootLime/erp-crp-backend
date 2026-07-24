-- Read-only verification for issue #226.
SELECT object_name, present
FROM (
  VALUES
    ('bon_livraison_command_receipts', to_regclass('public.bon_livraison_command_receipts') IS NOT NULL),
    ('bon_livraison_delivery_proofs', to_regclass('public.bon_livraison_delivery_proofs') IS NOT NULL),
    ('erp_outbox_events', to_regclass('public.erp_outbox_events') IS NOT NULL),
    ('v_bon_livraison_reliquats_226', to_regclass('public.v_bon_livraison_reliquats_226') IS NOT NULL)
) AS checks(object_name, present)
ORDER BY object_name;

SELECT
  count(*) FILTER (
    WHERE stock_movement_line_id IS NOT NULL
      AND (
        magasin_id IS NULL
        OR emplacement_id IS NULL
        OR location_id IS NULL
        OR stock_level_id IS NULL
      )
  ) AS shipped_allocations_without_source,
  count(*) FILTER (
    WHERE reservation_id IS NOT NULL
      AND stock_movement_line_id IS NULL
  ) AS active_or_unconsumed_allocation_links
FROM public.bon_livraison_ligne_allocations;

SELECT
  count(*) FILTER (WHERE status = 'ACTIVE' AND bon_livraison_ligne_id IS NOT NULL) AS active_bl_reservations,
  count(*) FILTER (WHERE status = 'CONSUMED' AND consumed_stock_movement_id IS NULL) AS invalid_consumed_reservations
FROM public.stock_reservations;

SELECT
  count(*) FILTER (WHERE checksum_sha256 IS NULL) AS documents_without_checksum,
  count(*) FILTER (WHERE checksum_sha256 IS NOT NULL AND checksum_sha256 !~ '^[A-Fa-f0-9]{64}$') AS invalid_checksums,
  count(*) FILTER (WHERE file_size_bytes IS NOT NULL AND file_size_bytes <= 0) AS invalid_file_sizes
FROM public.bon_livraison_documents;

SELECT
  count(*) FILTER (WHERE status IN ('PENDING', 'FAILED')) AS outbox_to_publish,
  count(*) FILTER (WHERE event_type = 'DELIVERY.SHIPPED') AS shipment_events
FROM public.erp_outbox_events;
