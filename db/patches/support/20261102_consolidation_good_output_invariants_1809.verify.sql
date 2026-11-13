\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.production_consolidations'::regclass AND attname='quantity_semantics' AND NOT attisdropped)
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.ordres_fabrication'::regclass AND tgname='check_consolidation_quantity_sources_1809' AND tgdeferrable AND tgenabled='O')
    OR NOT EXISTS(SELECT 1 FROM public.cerp_schema_migrations WHERE filename='20261102_consolidation_good_output_invariants_1809.sql') THEN
    RAISE EXCEPTION 'Consolidation good-output schema, trigger or registry entry is missing';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id
    WHERE c.state='ACTIVE' AND c.quantity_semantics='LEGACY_ALLOCATION_V1'
      AND o.quantite_lancee<>c.surplus_quantity+COALESCE((SELECT sum(a.quantity) FROM public.production_consolidation_allocations a WHERE a.consolidation_id=c.id AND a.state='ACTIVE'),0)
  ) THEN RAISE EXCEPTION 'Legacy consolidation conservation failed'; END IF;
  IF EXISTS(
    SELECT 1 FROM public.production_consolidations c JOIN public.ordres_fabrication o ON o.id=c.producer_of_id
    WHERE c.state='ACTIVE' AND c.quantity_semantics='GOOD_OUTPUT_V1'
      AND o.quantite_lancee<>c.surplus_quantity+COALESCE((SELECT sum(source.quantite_lancee) FROM public.production_consolidation_allocations a JOIN public.ordres_fabrication source ON source.id=a.source_of_id WHERE a.consolidation_id=c.id AND a.state='ACTIVE'),0)
  ) THEN RAISE EXCEPTION 'Good-output consolidation launch conservation failed'; END IF;
END $$;
SELECT quantity_semantics,state,count(*) FROM public.production_consolidations GROUP BY quantity_semantics,state ORDER BY quantity_semantics,state;
