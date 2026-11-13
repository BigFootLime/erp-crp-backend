BEGIN;

-- Keep the established delivery/deposit contractual guard intact, but do not
-- send an immutable supplier fulfilment receipt through it: that guard only
-- knows locally-owned delivery lines.  The dedicated validator installed by
-- the preceding intercompany invoice-source migration locks and validates the
-- signed external receipt line instead.
DROP TRIGGER IF EXISTS trg_validate_facture_source_allocation_227
  ON public.facture_source_allocations;

CREATE TRIGGER trg_validate_facture_source_allocation_227
  BEFORE INSERT ON public.facture_source_allocations
  FOR EACH ROW
  WHEN (NEW.source_type <> 'EXTERNAL_FULFILMENT_RECEIPT_LINE')
  EXECUTE FUNCTION public.fn_validate_invoice_source_1268();

DROP TRIGGER IF EXISTS trg_validate_external_fulfilment_invoice_source_1454
  ON public.facture_source_allocations;

CREATE TRIGGER trg_validate_external_fulfilment_invoice_source_1454
  BEFORE INSERT ON public.facture_source_allocations
  FOR EACH ROW
  WHEN (NEW.source_type = 'EXTERNAL_FULFILMENT_RECEIPT_LINE')
  EXECUTE FUNCTION public.fn_validate_facturation_allocation_227();

COMMIT;
