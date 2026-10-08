export const CUMP_RETURN_ORIGINAL_SQL = `SELECT e.id::text,e.article_id::text,e.source_sequence::text,e.kind,
  e.quantity_delta::text,e.movement_value::text,e.reliability,e.source_snapshot,
  e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
    AND e.source_snapshot->>'stock_source_sha256'=j.source_sha256 AS source_valid
  FROM public.stock_valuation_entries e JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.movement_id
  WHERE e.movement_id=$1::uuid AND e.owner_key=$2 AND e.stock_unit=$3 AND e.currency=$4 LIMIT 2`;

export const CUMP_RETURN_NET_CURSOR_SQL = `SELECT c.original_entry_id::text,c.quantity::text,c.value::text,c.latest_event_id::text,
  e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
    AND e.original_entry_id=c.original_entry_id AND e.original_movement_id=c.original_movement_id
    AND e.owner_key=c.owner_key AND e.stock_unit=c.stock_unit AND e.currency=c.currency
    AND(e.source_snapshot->'after_cursor'->>'quantity')::numeric=c.quantity
    AND(e.source_snapshot->'after_cursor'->>'value')::numeric IS NOT DISTINCT FROM c.value AS source_valid
  FROM public.stock_valuation_return_allocations c
  LEFT JOIN public.stock_valuation_return_allocation_events e ON e.id=c.latest_event_id
  WHERE c.original_movement_id=$1::uuid AND c.owner_key=$2 AND c.stock_unit=$3 AND c.currency=$4 FOR UPDATE OF c`;

export const CUMP_RETURN_ORIGINAL_EVENTS_SQL = `SELECT e.id::text,e.original_movement_id::text,e.original_entry_id::text,
  e.owner_key,e.stock_unit,e.currency,e.quantity_delta::text,e.value_delta::text,
  e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex') AS source_valid
  FROM public.stock_valuation_return_allocation_events e WHERE e.applied_entry_id=$1::uuid
  ORDER BY e.original_movement_id,e.id LIMIT 65`;

export const CUMP_RETURN_INSERT_EVENT_SQL = `INSERT INTO public.stock_valuation_return_allocation_events(
  id,original_movement_id,original_entry_id,applied_entry_id,applied_movement_id,owner_key,stock_unit,currency,
  previous_event_id,inverse_of_event_id,quantity_delta,value_delta,source_snapshot,source_sha256)
  VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::uuid,$10::uuid,$11::numeric,$12::numeric,
    $13::jsonb,encode(digest(($13::jsonb)::text,'sha256'),'hex')) RETURNING id::text`;

export const CUMP_RETURN_STORE_NET_CURSOR_SQL = `INSERT INTO public.stock_valuation_return_allocations(
  original_movement_id,owner_key,stock_unit,currency,original_entry_id,quantity,value,latest_event_id)
  VALUES($1::uuid,$2,$3,$4,$5::uuid,$6::numeric,$7::numeric,$8::uuid)
  ON CONFLICT(original_movement_id,owner_key,stock_unit,currency) DO UPDATE SET quantity=EXCLUDED.quantity,
    value=EXCLUDED.value,latest_event_id=EXCLUDED.latest_event_id
  WHERE stock_valuation_return_allocations.original_entry_id=EXCLUDED.original_entry_id RETURNING original_entry_id::text`;
