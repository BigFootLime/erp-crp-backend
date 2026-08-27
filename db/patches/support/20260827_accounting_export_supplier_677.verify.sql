DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_batch_sources_677_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_batch_source_type_677_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_entry_source_type_677_ck')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounting_claim_source_type_677_ck') THEN
    RAISE EXCEPTION 'ACCOUNTING-EXPORT-677 source constraints are incomplete';
  END IF;
END
$verify$;

SELECT source_type,count(*)
FROM public.accounting_export_batch_sources
GROUP BY source_type
ORDER BY source_type;
