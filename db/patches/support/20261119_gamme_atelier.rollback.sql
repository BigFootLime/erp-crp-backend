DO $$
BEGIN
  RAISE EXCEPTION 'Keep the additive routing schema and receipts during runtime rollback. Use the verified pre-upgrade backup to restore the previous business data state.';
END $$;
