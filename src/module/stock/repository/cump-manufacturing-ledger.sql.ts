const basisColumns=`b.id::text,b.of_id::text,b.margin_snapshot_id::text,b.quantity_good::text,b.total_cost_ht::text,
  b.currency,b.source_reliability,b.source_snapshot,b.source_sha256,
  b.source_sha256=encode(digest(b.source_snapshot::text,'sha256'),'hex') AS source_valid`;
export const CUMP_MANUFACTURING_BASIS_OF_SQL=`SELECT ${basisColumns}
  FROM public.stock_valuation_manufacturing_bases b WHERE b.of_id=$1::bigint`;
export const CUMP_MANUFACTURING_BASIS_ID_SQL=`SELECT ${basisColumns}
  FROM public.stock_valuation_manufacturing_bases b WHERE b.id=$1::uuid`;
export const CUMP_MANUFACTURING_CURSOR_SQL=`SELECT c.article_id::text,c.owner_key,c.stock_unit,c.currency,
  c.quantity::text,c.value::text,c.latest_event_id::text,
  e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
    AND(e.basis_id,e.article_id,e.owner_key,e.stock_unit,e.currency)
      IS NOT DISTINCT FROM(c.basis_id,c.article_id,c.owner_key,c.stock_unit,c.currency)
    AND(e.source_snapshot#>>'{after_budget,allocatedQuantity}')::numeric=c.quantity
    AND(e.source_snapshot#>>'{after_budget,allocatedValue}')::numeric=c.value
    AND v.source_sha256=encode(digest(v.source_snapshot::text,'sha256'),'hex')
    AND v.source_snapshot->>'manufacturing_allocation_event_id'=e.id::text
    AND e.source_snapshot->>'stock_source_sha256'=j.source_sha256 AS source_valid
  FROM public.stock_valuation_manufacturing_allocations c
  LEFT JOIN public.stock_valuation_manufacturing_allocation_events e ON e.id=c.latest_event_id
  LEFT JOIN public.stock_valuation_entries v ON v.id=e.applied_entry_id
  LEFT JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.applied_movement_id
  WHERE c.basis_id=$1::uuid FOR UPDATE OF c`;
export const CUMP_MANUFACTURING_PARENT_SQL=`SELECT e.id::text,e.basis_id::text,e.article_id::text,
  e.owner_key,e.stock_unit,e.currency,e.quantity_delta::text,e.value_delta::text,
  e.source_sha256=encode(digest(e.source_snapshot::text,'sha256'),'hex')
    AND v.source_sha256=encode(digest(v.source_snapshot::text,'sha256'),'hex')
    AND e.quantity_delta=v.quantity_delta AND abs(e.value_delta)=v.movement_value
    AND v.source_snapshot->>'manufacturing_allocation_event_id'=e.id::text
    AND e.source_snapshot->>'stock_source_sha256'=j.source_sha256 AS source_valid
  FROM public.stock_valuation_manufacturing_allocation_events e
  JOIN public.stock_valuation_entries v ON v.id=e.applied_entry_id
  JOIN public.stock_valuation_movement_journal j ON j.movement_id=e.applied_movement_id
  WHERE e.applied_entry_id=$1::uuid LIMIT 2`;
export const CUMP_MANUFACTURING_INSERT_EVENT_SQL=`INSERT INTO public.stock_valuation_manufacturing_allocation_events
  (id,basis_id,applied_entry_id,applied_movement_id,article_id,owner_key,stock_unit,currency,
    previous_event_id,inverse_of_event_id,quantity_delta,value_delta,source_snapshot,source_sha256)
  VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9::uuid,$10::uuid,$11::numeric,$12::numeric,
    $13::jsonb,encode(digest(($13::jsonb)::text,'sha256'),'hex')) RETURNING id::text`;
export const CUMP_MANUFACTURING_STORE_CURSOR_SQL=`INSERT INTO public.stock_valuation_manufacturing_allocations
  (basis_id,article_id,owner_key,stock_unit,currency,quantity,value,latest_event_id)
  VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::numeric,$7::numeric,$8::uuid)
  ON CONFLICT(basis_id) DO UPDATE SET quantity=EXCLUDED.quantity,value=EXCLUDED.value,latest_event_id=EXCLUDED.latest_event_id
  WHERE(stock_valuation_manufacturing_allocations.article_id,stock_valuation_manufacturing_allocations.owner_key,
    stock_valuation_manufacturing_allocations.stock_unit,stock_valuation_manufacturing_allocations.currency)
    IS NOT DISTINCT FROM(EXCLUDED.article_id,EXCLUDED.owner_key,EXCLUDED.stock_unit,EXCLUDED.currency)
  RETURNING basis_id::text`;
export const CUMP_MANUFACTURING_INVERSE_BOUNDS_SQL='SELECT public.fn_stock_manufacturing_inverse_bounds_1001($1::uuid) AS valid';
