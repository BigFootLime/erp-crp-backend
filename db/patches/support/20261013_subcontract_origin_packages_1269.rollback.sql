-- Never remove or merge real dossiers to restore an obsolete uniqueness rule.
BEGIN;
LOCK TABLE public.subcontract_work_packages IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.subcontract_work_packages GROUP BY of_operation_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'SUBCONTRACT_1269_ROLLBACK_REQUIRES_SINGLE_PACKAGE_PER_OPERATION';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.subcontract_work_packages'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (of_operation_id)') THEN
    ALTER TABLE public.subcontract_work_packages ADD CONSTRAINT subcontract_work_packages_of_operation_id_key UNIQUE(of_operation_id);
  END IF;
END $$;
COMMIT;
