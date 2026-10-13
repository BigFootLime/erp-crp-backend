SELECT
  NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.subcontract_work_packages'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (of_operation_id)') AS multiple_origin_packages_allowed,
  EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.subcontract_work_packages'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (supplier_order_line_id)') AS one_package_per_supplier_line,
  EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.subcontract_work_package_ledger'::regclass AND tgname='trg_subcontract_ledger_immutable_626') AS custody_ledger_immutable;
