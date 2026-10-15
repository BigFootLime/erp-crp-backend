-- Verification for the dependency-ordered #677 patch.
--
-- Finance #1268 deliberately supersedes the four #677 constraints as new
-- accounting sources are introduced.  A completed database must therefore
-- retain either the original supplier profile or the validated #1268
-- successor profile.  Do not accept names alone: each constraint must still
-- protect its owning registry and retain the supplier source contract.
DO $verify$
DECLARE
  legacy_profile boolean;
  successor_profile boolean;
BEGIN
  WITH expected(conname, table_name) AS (
    VALUES
      ('accounting_batch_sources_677_ck', 'accounting_export_batches'),
      ('accounting_batch_source_type_677_ck', 'accounting_export_batch_sources'),
      ('accounting_entry_source_type_677_ck', 'accounting_export_entries'),
      ('accounting_claim_source_type_677_ck', 'accounting_export_source_claims')
  )
  SELECT count(*) = 4
    INTO legacy_profile
    FROM expected e
    JOIN pg_class r ON r.relname = e.table_name AND r.relnamespace = 'public'::regnamespace
    JOIN pg_constraint c ON c.conrelid = r.oid AND c.conname = e.conname
   WHERE c.contype = 'c'
     AND c.convalidated
     AND pg_get_constraintdef(c.oid) LIKE '%SUPPLIER_INVOICE%'
     AND pg_get_constraintdef(c.oid) LIKE '%SUPPLIER_CREDIT_NOTE%';

  WITH expected(conname, table_name, definition) AS (
    VALUES
      ('accounting_batch_sources_1268_ck', 'accounting_export_batches',
       $$CHECK((((cardinality(source_types)>=1)AND(cardinality(source_types)<=8))AND(source_types<@ARRAY['INVOICE'::text,'CREDIT_NOTE'::text,'PAYMENT'::text,'SUPPLIER_INVOICE'::text,'SUPPLIER_CREDIT_NOTE'::text,'ADVANCE_VAT'::text,'CUSTOMER_REFUND'::text,'CUSTOMER_REFUND_REVERSAL'::text])))$$),
      ('accounting_batch_source_type_1268_ck', 'accounting_export_batch_sources',
       $$CHECK((source_type=ANY(ARRAY['INVOICE'::text,'CREDIT_NOTE'::text,'PAYMENT'::text,'SUPPLIER_INVOICE'::text,'SUPPLIER_CREDIT_NOTE'::text,'ADVANCE_VAT'::text,'CUSTOMER_REFUND'::text,'CUSTOMER_REFUND_REVERSAL'::text])))$$),
      ('accounting_entry_source_type_1268_ck', 'accounting_export_entries',
       $$CHECK((source_type=ANY(ARRAY['INVOICE'::text,'CREDIT_NOTE'::text,'PAYMENT'::text,'SUPPLIER_INVOICE'::text,'SUPPLIER_CREDIT_NOTE'::text,'ADVANCE_VAT'::text,'CUSTOMER_REFUND'::text,'CUSTOMER_REFUND_REVERSAL'::text])))$$),
      ('accounting_claim_source_type_1268_ck', 'accounting_export_source_claims',
       $$CHECK((source_type=ANY(ARRAY['INVOICE'::text,'CREDIT_NOTE'::text,'PAYMENT'::text,'SUPPLIER_INVOICE'::text,'SUPPLIER_CREDIT_NOTE'::text,'ADVANCE_VAT'::text,'CUSTOMER_REFUND'::text,'CUSTOMER_REFUND_REVERSAL'::text])))$$)
  )
  SELECT count(*) = 4
    INTO successor_profile
    FROM expected e
    JOIN pg_class r ON r.relname = e.table_name AND r.relnamespace = 'public'::regnamespace
    JOIN pg_constraint c ON c.conrelid = r.oid AND c.conname = e.conname
   WHERE c.contype = 'c'
     AND c.convalidated
     AND regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g') = e.definition;

  IF NOT COALESCE(legacy_profile, false)
     AND NOT COALESCE(successor_profile, false) THEN
    RAISE EXCEPTION 'ACCOUNTING-EXPORT-677 source constraints are incomplete';
  END IF;
END
$verify$;

SELECT source_type,count(*)
FROM public.accounting_export_batch_sources
GROUP BY source_type
ORDER BY source_type;
