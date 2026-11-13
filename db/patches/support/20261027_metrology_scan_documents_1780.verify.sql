-- Read-only verification: dedicated class must match the scan upload contract.
SELECT class_key, domain, nature, allowed_mime_types, allowed_extensions,
       max_size_bytes, approvals_required, retention_months, hold_on_publish
FROM public.ged_document_classes WHERE class_key = 'METROLOGIE_SCAN';
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ged_document_classes
    WHERE class_key = 'METROLOGIE_SCAN' AND domain = 'QUALITE' AND nature = 'EVIDENCE'
      AND allowed_mime_types = ARRAY['application/pdf','image/jpeg','image/png']
      AND allowed_extensions = ARRAY['.pdf','.jpg','.jpeg','.png']
      AND max_size_bytes = 26214400 AND approvals_required = 0
      AND retention_months = 120 AND hold_on_publish = true
  ) THEN RAISE EXCEPTION 'METROLOGIE_SCAN class differs from its reviewed contract'; END IF;
END $$;
