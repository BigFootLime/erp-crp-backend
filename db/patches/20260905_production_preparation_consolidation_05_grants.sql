-- #712: runtime privileges when migrations run through PostgreSQL peer auth.
-- Keep evidence tables owned by the migration administrator; no blanket grants.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE
      public.piece_version_preparation,
      public.of_stock_reviews,
      public.of_self_inspection_sheets,
      public.piece_version_programming_tasks,
      public.production_consolidations,
      public.production_consolidation_allocations,
      public.production_consolidation_receipt_allocations TO cerp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.of_preparation_evaluations TO cerp_app;
    GRANT SELECT, INSERT ON TABLE
      public.of_stock_reuse_decisions,
      public.production_consolidation_component_transfers TO cerp_app;
  END IF;
END
$grants$;
COMMIT;
