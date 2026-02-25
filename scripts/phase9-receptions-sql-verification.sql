-- Phase 9 SQL verification helpers

-- 1) Tables/columns present
SELECT to_regclass('public.receptions_fournisseurs') AS receptions_fournisseurs;
SELECT to_regclass('public.reception_fournisseur_lignes') AS reception_fournisseur_lignes;
SELECT to_regclass('public.reception_fournisseur_documents') AS reception_fournisseur_documents;
SELECT to_regclass('public.reception_incoming_inspections') AS reception_incoming_inspections;
SELECT to_regclass('public.reception_incoming_measurements') AS reception_incoming_measurements;
SELECT to_regclass('public.reception_fournisseur_stock_receipts') AS reception_fournisseur_stock_receipts;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'lots'
  AND column_name IN ('lot_status', 'lot_status_note')
ORDER BY column_name;

-- 2) Recent receptions overview (by newest)
SELECT
  r.id,
  r.reception_no,
  r.status,
  r.reception_date,
  f.code AS fournisseur_code,
  f.nom AS fournisseur_nom,
  COUNT(l.*) AS lines_count,
  r.updated_at
FROM public.receptions_fournisseurs r
JOIN public.fournisseurs f ON f.id = r.fournisseur_id
LEFT JOIN public.reception_fournisseur_lignes l ON l.reception_id = r.id
GROUP BY r.id, f.code, f.nom
ORDER BY r.updated_at DESC
LIMIT 20;

-- 3) Lines + lot status + inspection decision
SELECT
  l.reception_id,
  l.line_no,
  a.code AS article_code,
  l.qty_received,
  l.unite,
  l.lot_id,
  lot.lot_code,
  lot.lot_status,
  i.status AS inspection_status,
  i.decision AS inspection_decision,
  i.decided_at
FROM public.reception_fournisseur_lignes l
LEFT JOIN public.articles a ON a.id = l.article_id
LEFT JOIN public.lots lot ON lot.id = l.lot_id
LEFT JOIN public.reception_incoming_inspections i ON i.reception_line_id = l.id
ORDER BY l.updated_at DESC
LIMIT 100;

-- 4) Reception documents
SELECT
  d.reception_id,
  d.document_type,
  d.original_name,
  d.mime_type,
  d.size_bytes,
  d.created_at
FROM public.reception_fournisseur_documents d
WHERE d.removed_at IS NULL
ORDER BY d.created_at DESC
LIMIT 50;

-- 5) Stock receipt movements linked to receptions
SELECT
  sr.reception_id,
  sr.reception_line_id,
  sr.stock_movement_id,
  sr.qty,
  sr.created_at
FROM public.reception_fournisseur_stock_receipts sr
ORDER BY sr.created_at DESC
LIMIT 50;
