/** Internal capture diagnostics. No financial projection or user-supplied cost.
 * The immutable journal is captured by the deferred Stock posting trigger. */
export const STOCK_VALUATION_CAPTURE_STATUS_SQL = `
SELECT b.mode,b.started_at::text,b.schema_version,
  count(j.id)::text AS captured_movements,
  count(j.id) FILTER(WHERE j.capture_status='SOURCE_INCOMPLETE')::text AS incomplete_sources,
  max(j.sequence)::text AS latest_sequence,max(j.recorded_at)::text AS latest_capture_at
FROM public.stock_valuation_capture_boundary b
LEFT JOIN public.stock_valuation_movement_journal j ON($1::uuid IS NULL OR j.article_id=$1::uuid)
GROUP BY b.mode,b.started_at,b.schema_version`;
