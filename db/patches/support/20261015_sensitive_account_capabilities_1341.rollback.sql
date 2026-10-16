-- Non-destructive rollback: restore the previous application artifact only after
-- reviewing its security risk. Preserve this additive registry and all decisions.
-- No table or grant is removed; a rollback must not destroy authorization evidence.
SELECT to_regclass('public.app_user_sensitive_capabilities') IS NOT NULL AS retained_registry;
