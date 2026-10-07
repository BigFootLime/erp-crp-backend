-- Application rollback only: preserve this additive column and its projections.
-- Deploy the previous attested API/frontend artifacts. Do not remove placement
-- evidence, change commitments, or rewrite the migration ledger.
SELECT count(*) AS projections_retained FROM public.planning_tasks WHERE forecast_resource_ids IS NOT NULL;
