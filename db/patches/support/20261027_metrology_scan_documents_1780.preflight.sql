-- Read-only checks before creating the dedicated documentary scan class.
SELECT to_regclass('public.ged_document_classes') AS classes,
       to_regclass('public.metrologie_equipements') AS equipment,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') AS cerp_app_role_present;
SELECT class_key, domain, nature, allowed_mime_types, allowed_extensions,
       max_size_bytes, approvals_required, retention_months, hold_on_publish
FROM public.ged_document_classes WHERE class_key = 'METROLOGIE_SCAN';
