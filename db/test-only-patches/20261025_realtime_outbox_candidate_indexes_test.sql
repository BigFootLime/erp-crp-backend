\set ON_ERROR_STOP on
SELECT current_database() = 'cerp_test' AS tooling_test_database \gset
\if :tooling_test_database
CREATE INDEX CONCURRENTLY IF NOT EXISTS erp_outbox_realtime_candidate_ready_20261025_idx
  ON public.erp_outbox_events (created_at, id)
  INCLUDE (available_at, realtime_stream_id, realtime_stream_ordinal)
  WHERE aggregate_type = 'REALTIME' AND event_type = 'REALTIME.DISPATCH'
    AND status IN ('PENDING', 'FAILED');
CREATE INDEX CONCURRENTLY IF NOT EXISTS erp_outbox_realtime_predecessor_20261025_idx
  ON public.erp_outbox_events (aggregate_type, event_type, realtime_stream_id, realtime_stream_ordinal)
  WHERE status <> 'PUBLISHED';
\else
\quit 3
\endif
