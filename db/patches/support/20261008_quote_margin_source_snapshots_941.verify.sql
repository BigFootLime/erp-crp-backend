DO $$ BEGIN
  IF to_regclass('public.quote_margin_source_snapshots') IS NULL THEN RAISE EXCEPTION 'Quote capture table missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.quote_margin_source_snapshots'::regclass
    AND tgname='quote_margin_source_snapshots_immutable' AND tgenabled='O') THEN RAISE EXCEPTION 'Immutable capture guard missing'; END IF;
  IF EXISTS(SELECT 1 FROM public.quote_margin_source_snapshots s LEFT JOIN public.devis d ON d.id=s.devis_id
    LEFT JOIN public.devis_ligne l ON l.id=s.line_id
    WHERE d.id IS NULL OR (s.line_id IS NOT NULL AND (l.id IS NULL OR l.devis_id<>s.devis_id))
      OR COALESCE(d.version_number,1)<>s.quote_version) THEN RAISE EXCEPTION 'Quote capture provenance mismatch'; END IF;
END $$;
