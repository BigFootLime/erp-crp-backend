-- Retain any operation-specific rates already entered; no automatic destructive rollback.
DO $$ BEGIN RAISE EXCEPTION 'Keep prix_vente_horaire and its audit trail; runtime rollback only after reviewing newly entered rates.'; END $$;
