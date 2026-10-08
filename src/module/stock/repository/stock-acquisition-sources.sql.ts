/** Internal immutable source input for the future Stock projector. Acquisition
 * capture starts at its own boundary; earlier movement proofs stay untouched. */
export const STOCK_ACQUISITION_CAPTURE_STATUS_SQL = `
SELECT b.started_at::text,b.schema_version,count(s.movement_id)::text AS captured_receipts,
  count(s.movement_id) FILTER(WHERE jsonb_array_length(s.source_issues)>0)::text AS incomplete_sources,
  max(j.sequence)::text AS latest_sequence
FROM public.stock_valuation_acquisition_boundary b
LEFT JOIN public.stock_valuation_acquisition_sources s ON true
LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=s.movement_id
GROUP BY b.started_at,b.schema_version`;

export const STOCK_ACQUISITION_SOURCE_WINDOW_SQL = `
SELECT j.sequence::text,j.movement_id::text,j.article_id::text,j.source_snapshot AS movement_snapshot,
  j.source_sha256 AS movement_sha256,j.source_issues AS movement_issues,
  s.source_snapshot AS acquisition_snapshot,s.source_sha256 AS acquisition_sha256,s.source_issues AS acquisition_issues
FROM public.stock_valuation_movement_journal j
LEFT JOIN public.stock_valuation_acquisition_sources s ON s.movement_id=j.movement_id
WHERE j.sequence>$1::bigint AND ($2::uuid IS NULL OR j.article_id=$2::uuid)
ORDER BY j.sequence LIMIT $3::integer`;
