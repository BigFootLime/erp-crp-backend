\set ON_ERROR_STOP on

DO $$ BEGIN
  IF to_regclass('public.adv_delivery_blocks') IS NULL OR to_regclass('public.adv_payment_promises') IS NULL
     OR to_regclass('public.adv_invoice_disputes') IS NULL OR to_regclass('public.adv_case_events') IS NULL
     OR to_regclass('public.adv_otif_assessments') IS NULL OR to_regclass('public.adv_command_receipts') IS NULL THEN
    RAISE EXCEPTION 'Tables SOL-23 absentes';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_adv_freeze_otif_0455' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Trigger OTIF absent'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_adv_case_events_append_only_0455' AND NOT tgisinternal) THEN RAISE EXCEPTION 'Audit ADV append-only absent'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='adv_delivery_blocks_active_0455_uq') THEN RAISE EXCEPTION 'Unicite blocage actif absente'; END IF;
END $$;

SELECT current_database() AS database_name,
       (SELECT count(*) FROM public.adv_delivery_blocks) AS delivery_blocks,
       (SELECT count(*) FROM public.adv_payment_promises) AS payment_promises,
       (SELECT count(*) FROM public.adv_invoice_disputes) AS invoice_disputes,
       (SELECT count(*) FROM public.adv_otif_assessments) AS frozen_otif;

SELECT count(*) AS orphan_delivery_blocks FROM public.adv_delivery_blocks b LEFT JOIN public.bon_livraison bl ON bl.id=b.delivery_id WHERE bl.id IS NULL;
SELECT count(*) AS orphan_promises FROM public.adv_payment_promises p LEFT JOIN public.facture f ON f.id=p.facture_id WHERE f.id IS NULL;
SELECT count(*) AS orphan_disputes FROM public.adv_invoice_disputes d LEFT JOIN public.facture f ON f.id=d.facture_id WHERE f.id IS NULL;
