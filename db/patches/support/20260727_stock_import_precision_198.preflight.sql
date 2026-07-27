\set ON_ERROR_STOP on

DO $$
DECLARE
  current_scale integer;
  unsafe_mismatches integer;
  multi_line_openings integer;
BEGIN
  IF current_database() <> 'cerp_test' THEN
    RAISE EXCEPTION 'Preflight #198 refused outside cerp_test (current database: %)', current_database();
  END IF;

  SELECT numeric_scale
    INTO current_scale
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'stock_movement_lines'
    AND column_name = 'qty';

  IF current_scale NOT IN (3, 6) THEN
    RAISE EXCEPTION 'Preflight #198 refused: unexpected stock_movement_lines.qty scale %', current_scale;
  END IF;

  WITH opening_lines AS (
    SELECT
      l.movement_id,
      l.qty AS line_qty,
      m.qty AS posted_qty,
      COUNT(*) OVER (PARTITION BY l.movement_id) AS lines_count
    FROM public.stock_movement_lines l
    JOIN public.stock_movements m ON m.id = l.movement_id
    WHERE m.status = 'POSTED'
      AND m.source_document_type = 'CLIPPER_STOCK_OPENING'
  )
  SELECT
    COUNT(*) FILTER (
      WHERE line_qty IS DISTINCT FROM posted_qty
        AND abs(line_qty - posted_qty) >= 0.0005
    ),
    COUNT(DISTINCT movement_id) FILTER (WHERE lines_count <> 1)
  INTO unsafe_mismatches, multi_line_openings
  FROM opening_lines;

  IF unsafe_mismatches > 0 THEN
    RAISE EXCEPTION 'Preflight #198 refused: % opening line/header mismatches are not rounding residues', unsafe_mismatches;
  END IF;
  IF multi_line_openings > 0 THEN
    RAISE EXCEPTION 'Preflight #198 refused: % CLIPPER opening movements contain multiple lines', multi_line_openings;
  END IF;
END
$$;

SELECT
  c.numeric_precision,
  c.numeric_scale,
  COUNT(*) FILTER (
    WHERE m.status = 'POSTED'
      AND m.source_document_type = 'CLIPPER_STOCK_OPENING'
      AND l.qty IS DISTINCT FROM m.qty
  ) AS opening_mismatches_before
FROM information_schema.columns c
CROSS JOIN public.stock_movement_lines l
JOIN public.stock_movements m ON m.id = l.movement_id
WHERE c.table_schema = 'public'
  AND c.table_name = 'stock_movement_lines'
  AND c.column_name = 'qty'
GROUP BY c.numeric_precision, c.numeric_scale;
