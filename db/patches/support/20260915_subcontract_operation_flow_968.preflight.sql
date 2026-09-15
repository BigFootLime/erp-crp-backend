-- Read only. Review on the approved target before applying the migration.
SELECT current_database(),current_user;
SELECT to_regclass('public.reception_subcontract_origins') AS receipt_origins,
       to_regclass('public.production_transfer_batches') AS transfers,
       to_regprocedure('public.planning_invalidate()') AS invalidation;
SELECT p.id,p.qty_planned,sum(e.qty) AS issued
FROM public.subcontract_work_packages p JOIN public.subcontract_work_package_ledger e ON e.package_id=p.id
WHERE e.event_type='ISSUE' GROUP BY p.id HAVING sum(e.qty)>p.qty_planned;
-- Historical returns stay quarantined for downstream use until linked through Receipts.
SELECT count(*) AS returns_without_origins FROM public.subcontract_work_package_ledger e
WHERE e.event_type='RETURN' AND NOT EXISTS(SELECT 1 FROM public.reception_subcontract_origins r WHERE r.return_event_id=e.id);
