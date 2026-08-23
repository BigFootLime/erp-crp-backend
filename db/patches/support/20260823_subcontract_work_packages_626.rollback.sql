-- TEST-ONLY rollback: never execute on a DB containing #626 records.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.subcontract_work_packages) THEN RAISE EXCEPTION 'SUBCONTRACT_626_ROLLBACK_REQUIRES_EMPTY_TABLES'; END IF; END $$;
DROP TABLE IF EXISTS public.subcontract_work_package_ledger;
DROP TABLE IF EXISTS public.subcontract_work_packages;
DROP FUNCTION IF EXISTS public.fn_subcontract_ledger_immutable_626();
DROP FUNCTION IF EXISTS public.fn_subcontract_ledger_contract_626();
DROP FUNCTION IF EXISTS public.fn_subcontract_package_contract_626();
