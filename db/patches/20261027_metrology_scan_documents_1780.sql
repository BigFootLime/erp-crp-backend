-- Instrument scans are documentary evidence, never a qualification.
-- Existing GED storage, AV, audit and retention rules remain authoritative.
BEGIN;
INSERT INTO public.ged_document_classes
  (class_key, domain, label, nature, allowed_mime_types, allowed_extensions,
   max_size_bytes, approvals_required, retention_months, hold_on_publish)
VALUES
  ('METROLOGIE_SCAN', 'QUALITE', 'Document et scan instrument', 'EVIDENCE',
   ARRAY['application/pdf','image/jpeg','image/png'],
   ARRAY['.pdf','.jpg','.jpeg','.png'], 26214400, 0, 120, true)
ON CONFLICT (class_key) DO NOTHING;
COMMIT;
