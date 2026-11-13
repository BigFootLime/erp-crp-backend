SELECT to_regclass('public.cerp_company_policy_projections') IS NOT NULL AS installed;
SELECT count(*) AS invalid_scope_rows FROM public.cerp_company_policy_projections
 WHERE company_version<1 OR membership_version<1 OR instance_version<1 OR policy_hash!~'^[a-f0-9]{64}$';
SELECT bool_and(has_table_privilege('cerp_app','public.cerp_company_policy_projections',permission)) AS app_permissions
 FROM unnest(ARRAY['SELECT','INSERT','UPDATE']) AS permissions(permission);
SELECT NOT has_table_privilege('cerp_app','public.cerp_company_policy_projections','DELETE') AS deletion_restricted;
