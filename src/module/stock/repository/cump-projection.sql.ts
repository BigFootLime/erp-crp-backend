export const CUMP_CONTROL_SQL = `SELECT mode,reporting_currency,formula_version,initialized,last_sequence::text
  FROM public.stock_valuation_projector_control WHERE singleton FOR UPDATE`;

export const CUMP_OPENING_SOURCES_SQL = `SELECT id::text,stock_level_id::text,stock_batch_id::text,article_id::text,
  source_snapshot,source_sha256=encode(digest(source_snapshot::text,'sha256'),'hex') AS source_valid
  FROM public.stock_valuation_opening_quantities ORDER BY article_id,stock_level_id,stock_batch_id NULLS FIRST LIMIT 10001`;

const journalColumns = `j.sequence::text,j.movement_id::text,j.article_id::text,j.source_snapshot,j.source_sha256,
  j.source_sha256=encode(digest(j.source_snapshot::text,'sha256'),'hex') AS source_valid,
  a.source_snapshot AS acquisition_snapshot,a.source_sha256 AS acquisition_sha256,
  a.source_sha256=encode(digest(a.source_snapshot::text,'sha256'),'hex')
    AND a.source_snapshot->>'stock_source_sha256'=j.source_sha256 AS acquisition_valid,
  r.source_snapshot AS return_snapshot,r.source_sha256 AS return_sha256,
  r.source_sha256=encode(digest(r.source_snapshot::text,'sha256'),'hex')
    AND r.source_snapshot->>'stock_source_sha256'=j.source_sha256
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.source_snapshot->'remnants')='array'
      THEN r.source_snapshot->'remnants' ELSE '[]'::jsonb END) link
      LEFT JOIN public.stock_valuation_movement_journal original ON original.movement_id::text=link->>'original_movement_id'
      WHERE original.movement_id IS NULL OR link->>'original_stock_source_sha256' IS DISTINCT FROM original.source_sha256
        OR link->'original_stock_source' IS DISTINCT FROM original.source_snapshot) AS return_valid`;
export const CUMP_SOURCE_WINDOW_SQL = `SELECT ${journalColumns}
  FROM public.stock_valuation_movement_journal j
  LEFT JOIN public.stock_valuation_acquisition_sources a ON a.movement_id=j.movement_id
  LEFT JOIN public.stock_valuation_return_sources r ON r.movement_id=j.movement_id
  WHERE j.sequence>$1::bigint ORDER BY j.sequence LIMIT $2::integer`;
export const CUMP_TRANSFER_GROUP_SQL = `SELECT ${journalColumns}
  FROM public.stock_valuation_movement_journal j
  LEFT JOIN public.stock_valuation_acquisition_sources a ON a.movement_id=j.movement_id
  LEFT JOIN public.stock_valuation_return_sources r ON r.movement_id=j.movement_id
  WHERE j.movement_id=$1::uuid OR(j.source_snapshot->>'document_type'='STOCK_TRANSFER_INTERNAL'
    AND j.source_snapshot->>'document_id'=$1::text) ORDER BY j.sequence LIMIT 4`;

export const CUMP_SCOPE_BALANCE_SQL = `SELECT quantity::text,value::text,reliability,source_ref,
  latest_sequence::text,latest_entry_id::text FROM public.stock_valuation_balances
  WHERE article_id=$1::uuid AND owner_key=$2 AND stock_unit=$3 AND currency=$4 FOR UPDATE`;
export const CUMP_BLOCKED_ARTICLE_SQL = `SELECT 1 FROM public.stock_valuation_entries
  WHERE article_id=$1::uuid AND(kind='UNRESOLVED' OR source_snapshot->'blocking'='true'::jsonb) LIMIT 1`;

export const CUMP_INSERT_ENTRY_SQL = `INSERT INTO public.stock_valuation_entries(
  id,movement_id,article_id,owner_key,stock_unit,currency,source_sequence,kind,formula_version,
  quantity_delta,value_delta,movement_value,reliability,source_snapshot,source_sha256,issues)
  VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::bigint,$8,$9,$10::numeric,$11::numeric,$12::numeric,$13,
    $14::jsonb,encode(digest(($14::jsonb)::text,'sha256'),'hex'),$15::jsonb) RETURNING id::text`;
export const CUMP_STORE_BALANCE_SQL = `INSERT INTO public.stock_valuation_balances(
  article_id,owner_key,stock_unit,currency,quantity,value,reliability,source_ref,latest_sequence,latest_entry_id)
  VALUES($1::uuid,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9::bigint,$10::uuid)
  ON CONFLICT(article_id,owner_key,stock_unit,currency) DO UPDATE SET quantity=EXCLUDED.quantity,value=EXCLUDED.value,
    reliability=EXCLUDED.reliability,source_ref=EXCLUDED.source_ref,latest_sequence=EXCLUDED.latest_sequence,
    latest_entry_id=EXCLUDED.latest_entry_id,updated_at=clock_timestamp()`;

export const CUMP_FEE_CURSOR_SQL = `SELECT quantity::text,basis_snapshot,poisoned,
  basis_sha256=encode(digest(basis_snapshot::text,'sha256'),'hex') AS source_valid
  FROM public.stock_valuation_acquisition_allocations WHERE order_line_id=$1::uuid FOR UPDATE`;
export const CUMP_STORE_FEE_CURSOR_SQL = `INSERT INTO public.stock_valuation_acquisition_allocations(
  order_line_id,quantity,basis_snapshot,basis_sha256,poisoned)
  VALUES($1::uuid,$2::numeric,$3::jsonb,encode(digest(($3::jsonb)::text,'sha256'),'hex'),$4::boolean)
  ON CONFLICT(order_line_id) DO UPDATE SET quantity=EXCLUDED.quantity,
    poisoned=stock_valuation_acquisition_allocations.poisoned OR EXCLUDED.poisoned,updated_at=clock_timestamp()`;

/** An existing uncaptured receipt makes the first fee cursor unsafe. This is a
 * missing-proof check, not a mutable SUM used as an allocation quantity. */
export const CUMP_FEE_HISTORY_GAP_SQL = `SELECT EXISTS(
  SELECT 1 FROM public.reception_fournisseur_stock_receipts s
  JOIN public.stock_movements m ON m.id=s.stock_movement_id
  JOIN public.reception_fournisseur_lignes l ON l.id=s.reception_line_id
  JOIN public.receptions_fournisseurs r ON r.id=s.reception_id
  LEFT JOIN public.stock_valuation_acquisition_sources a ON a.movement_id=s.stock_movement_id
  WHERE m.posted_at IS NOT NULL AND(l.commande_fournisseur_ligne_id=$1::uuid
    OR(l.commande_fournisseur_ligne_id IS NULL AND r.commande_fournisseur_id=$2::uuid))
    AND(a.movement_id IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.source_snapshot->'receipts') receipt
      WHERE receipt->>'receipt_stock_id'=s.id::text AND receipt->'order'->>'line_id'=$1::text))
  ) OR EXISTS(
    SELECT 1 FROM public.stock_valuation_acquisition_sources a
    JOIN public.stock_valuation_movement_journal j ON j.movement_id=a.movement_id
    WHERE j.sequence<$3::bigint AND a.source_snapshot @> jsonb_build_object('receipts',jsonb_build_array(
      jsonb_build_object('order',jsonb_build_object('line_id',$1::text))))
      AND NOT EXISTS(SELECT 1 FROM public.stock_valuation_entries e WHERE e.movement_id=a.movement_id
        AND e.source_snapshot->'acquisition_fee_counted'='true'::jsonb)
  ) AS missing`;

export const CUMP_ADVANCE_CONTROL_SQL = `UPDATE public.stock_valuation_projector_control
  SET initialized=true,last_sequence=$1::bigint,calculated_at=clock_timestamp(),last_error=NULL
  WHERE singleton AND mode='ACTIVE' AND last_sequence<=$1::bigint RETURNING last_sequence::text`;

/** A stored balance alone is insufficient: article-level unresolved evidence
 * and a newer posting with no projection suppress financial reliability. */
export const CUMP_PROJECTION_STATUS_SQL = `SELECT c.mode,c.reporting_currency,c.formula_version,c.initialized,
  c.last_sequence::text,c.calculated_at::text,c.last_error,
  (SELECT count(*)::text FROM public.stock_valuation_movement_journal j WHERE j.sequence>c.last_sequence) AS pending_movements,
  (SELECT count(DISTINCT article_id)::text FROM public.stock_valuation_entries e
    WHERE e.kind='UNRESOLVED' OR e.source_snapshot->'blocking'='true'::jsonb) AS blocked_articles
  FROM public.stock_valuation_projector_control c WHERE singleton`;
