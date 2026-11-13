SELECT to_regclass('public.supplier_portal_accounts') IS NOT NULL AS supplier_portal_installed,
       to_regclass('public.supplier_internal_treatment_estimates') IS NOT NULL AS internal_treatment_estimates_installed,
       COALESCE((SELECT enabled FROM public.supplier_portal_configuration WHERE id=true),false) AS supplier_portal_enabled;
SELECT count(*) = 1 AS single_dormant_configuration
FROM public.supplier_portal_configuration WHERE id=true;
