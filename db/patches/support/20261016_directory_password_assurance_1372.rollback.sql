-- Older binaries may be restored without removing this additive capability.
DO $$ BEGIN
  RAISE EXCEPTION 'Retain nullable assurance during binary rollback; coordinate source policy and employee sessions before any schema removal';
END $$;
