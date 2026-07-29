\set ON_ERROR_STOP on

DO $verify$
DECLARE
  missing_read_count integer;
  missing_admin_count integer;
  invalid_count integer;
BEGIN
  IF to_regclass('public.ged_class_capabilities') IS NULL THEN
    RAISE EXCEPTION '#236: public.ged_class_capabilities absente';
  END IF;

  SELECT COUNT(*) INTO missing_read_count
    FROM public.ged_document_classes c
   WHERE c.is_active
     AND NOT EXISTS (
       SELECT 1 FROM public.ged_class_capabilities p
        WHERE p.class_key = c.class_key
          AND p.capability IN ('read', 'admin')
     );
  IF missing_read_count <> 0 THEN
    RAISE EXCEPTION '#236: % classe(s) active(s) sans lecture autorisée', missing_read_count;
  END IF;

  SELECT COUNT(*) INTO missing_admin_count
    FROM public.ged_document_classes c
   WHERE c.is_active
     AND NOT EXISTS (
       SELECT 1 FROM public.ged_class_capabilities p
        WHERE p.class_key = c.class_key
          AND p.role_key = 'Administrateur Systeme et Reseau'
          AND p.capability = 'admin'
     );
  IF missing_admin_count <> 0 THEN
    RAISE EXCEPTION '#236: % classe(s) active(s) sans administration explicite', missing_admin_count;
  END IF;

  SELECT COUNT(*) INTO invalid_count
    FROM public.ged_class_capabilities
   WHERE role_key <> btrim(role_key)
      OR role_key = '';
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION '#236: % permission(s) avec rôle non canonique', invalid_count;
  END IF;
END
$verify$;

SELECT class_key, COUNT(*) AS permissions_count
  FROM public.ged_class_capabilities
 GROUP BY class_key
 ORDER BY class_key;

SELECT 'GED_SCOPE_SECURITY_236_VERIFY_OK' AS result;
