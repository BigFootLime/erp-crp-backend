DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.paiement_allocations'::regclass
     AND attname='advance_vat_snapshot' AND NOT attisdropped AND atttypid='jsonb'::regtype)
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.paiement_allocations'::regclass AND tgname='trg_advance_cash_vat_1268' AND tgenabled='O')
   OR (SELECT count(*) FROM pg_constraint WHERE conname IN('accounting_batch_sources_1268_ck','accounting_batch_source_type_1268_ck',
       'accounting_entry_source_type_1268_ck','accounting_claim_source_type_1268_ck'))<>4 THEN
   RAISE EXCEPTION 'ADVANCE-VAT-1268 storage verification failed';
 END IF;
END $$;
