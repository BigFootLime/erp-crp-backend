-- Functional rollback only: keep all evidence, allocations and execution guards.
-- Run after the operator's release decision. No schema or data is deleted.
\set ON_ERROR_STOP on
BEGIN;
UPDATE public.app_feature_flags SET enabled=false,updated_at=now() WHERE key IN ('PRODUCTION_WORKBENCH','PRODUCTION_CONSOLIDATION');
COMMIT;
