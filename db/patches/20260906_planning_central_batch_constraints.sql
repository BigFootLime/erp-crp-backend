-- Deferred final-state verification enables atomic exchanges of existing committed slots.
-- Recreates the same predicates; it does not permit overlaps or rewrite existing events.
BEGIN;
DO $$ DECLARE resource text; constraint_name text; BEGIN
  FOREACH resource IN ARRAY ARRAY['machine','poste'] LOOP
    constraint_name:='planning_events_'||resource||'_no_overlap';
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE conname=constraint_name AND condeferrable) THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.planning_events DROP CONSTRAINT IF EXISTS %I',constraint_name);
    EXECUTE format('ALTER TABLE public.planning_events ADD CONSTRAINT %I EXCLUDE USING gist
      (%I WITH =, tstzrange(start_ts,end_ts,''[)'') WITH &&)
      WHERE (%I IS NOT NULL AND archived_at IS NULL AND allow_overlap IS NOT TRUE)
      DEFERRABLE INITIALLY IMMEDIATE',constraint_name,resource||'_id',resource||'_id');
  END LOOP;
END $$;
COMMIT;

