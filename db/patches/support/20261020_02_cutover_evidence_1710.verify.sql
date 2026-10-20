SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='data_cutover_evidence_links';
SELECT tgname FROM pg_trigger WHERE tgrelid='public.data_cutover_evidence_links'::regclass AND NOT tgisinternal;
