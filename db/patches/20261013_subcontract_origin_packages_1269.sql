-- One material origin per purchase line, several lines for one treatment phase.
-- Preserve every package/ledger row and the unique supplier-line identity.
BEGIN;
ALTER TABLE public.subcontract_work_packages
  DROP CONSTRAINT IF EXISTS subcontract_work_packages_of_operation_id_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.subcontract_work_packages'::regclass
      AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (supplier_order_line_id)'
  ) THEN
    RAISE EXCEPTION 'SUBCONTRACT_SUPPLIER_LINE_UNIQUENESS_REQUIRED';
  END IF;
END $$;
COMMIT;
