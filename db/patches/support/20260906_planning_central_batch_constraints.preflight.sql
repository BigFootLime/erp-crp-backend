DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_extension WHERE extname='btree_gist') THEN
    RAISE EXCEPTION 'btree_gist extension missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.planning_events a JOIN public.planning_events b ON a.id<b.id
    AND ((a.machine_id=b.machine_id) OR (a.poste_id=b.poste_id))
    AND tstzrange(a.start_ts,a.end_ts,'[)') && tstzrange(b.start_ts,b.end_ts,'[)')
    WHERE a.archived_at IS NULL AND b.archived_at IS NULL
      AND a.allow_overlap IS NOT TRUE AND b.allow_overlap IS NOT TRUE) THEN
    RAISE EXCEPTION 'Existing planning overlaps require reconciliation before migration';
  END IF;
END $$;
