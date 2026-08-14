\set ON_ERROR_STOP on
DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(name,', ') INTO missing FROM (VALUES
    ('accounting_export_mapping_versions'),('accounting_export_batches'),('accounting_export_batch_sources'),
    ('accounting_export_entries'),('accounting_export_source_claims'),('accounting_export_command_receipts')
  ) expected(name) WHERE to_regclass('public.'||name) IS NULL;
  IF missing IS NOT NULL THEN RAISE EXCEPTION 'SOL-27 missing tables: %',missing; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='accounting_source_active_claim_sol27_uq') THEN
    RAISE EXCEPTION 'SOL-27 active source claim uniqueness is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_protect_accounting_batch_sol27','trg_protect_accounting_sources_sol27','trg_protect_accounting_entries_sol27') AND NOT tgisinternal) <> 3 THEN
    RAISE EXCEPTION 'SOL-27 immutability triggers are incomplete';
  END IF;
  IF position('old_row jsonb := to_jsonb(OLD)' IN pg_get_functiondef('public.fn_protect_facturation_immutable_227()'::regprocedure)) = 0
     OR position('OLD.document_status' IN pg_get_functiondef('public.fn_protect_facturation_immutable_227()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'SOL-27 facture/avoir immutability compatibility fix is missing';
  END IF;
END $$;

SELECT status,count(*) AS batches FROM public.accounting_export_batches GROUP BY status ORDER BY status;
SELECT count(*) FILTER (WHERE released_at IS NULL) AS active_claims,
       count(*) FILTER (WHERE released_at IS NOT NULL) AS released_claims
FROM public.accounting_export_source_claims;
SELECT count(*) AS unbalanced_currency_groups FROM (
  SELECT batch_id,currency FROM public.accounting_export_entries GROUP BY batch_id,currency HAVING sum(debit)<>sum(credit)
) drift;
