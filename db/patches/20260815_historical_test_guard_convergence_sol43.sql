-- SOL-43 — converge four historical migrations that were intentionally guarded
-- to cerp_test. The final state is applied atomically and the legacy ledger
-- entries are recorded only after all preconditions have been verified.

BEGIN;

DO $$
DECLARE
  current_scale integer;
  mismatch_count integer;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'SOL-43 convergence refused on database %', current_database();
  END IF;

  IF to_regclass('public.contacts') IS NULL
     OR to_regclass('public.data_import_batches') IS NULL
     OR to_regclass('public.stock_movement_lines') IS NULL
     OR to_regclass('public.stock_movements') IS NULL
     OR to_regclass('public.stock_movement_event_log') IS NULL
     OR to_regclass('public.cerp_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'SOL-43 convergence refused: required tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.contacts
     WHERE client_id IS NOT NULL
       AND email IS NOT NULL
       AND btrim(email) <> ''
       AND archived_at IS NULL
     GROUP BY
       client_id,
       lower(btrim(email)),
       lower(btrim(coalesce(first_name, ''))),
       lower(btrim(coalesce(last_name, '')))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SOL-43 convergence refused: duplicate active contact identities exist';
  END IF;

  SELECT numeric_scale
    INTO current_scale
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'stock_movement_lines'
     AND column_name = 'qty';

  IF current_scale NOT IN (3, 6) THEN
    RAISE EXCEPTION 'SOL-43 convergence refused: unexpected stock quantity scale %', current_scale;
  END IF;

  SELECT count(*)::integer
    INTO mismatch_count
    FROM public.cerp_schema_migrations AS applied
    JOIN (VALUES
      ('20260727_contacts_email_scope_187.sql', '4d43141bc2e6b803f4b37d1dff146c9950e64c75f0b317194ebf03dacbddbf1a'),
      ('20260727_contacts_shared_email_identity_190.sql', 'b3b030cefbbf16ceca44481d74380de71803d72320c19b4da9cc62eee37aaf89'),
      ('20260727_import_supplier_orders_312.sql', '5988f518ebfe8160372ec833fb14fba636a54638f367a637703162032d7193a0'),
      ('20260727_stock_import_precision_198.sql', '0a348b7d6b723ba2d38b4927a5eed9a3999e3dfa82f56940f1f3a4d5b2da5a6a')
    ) AS expected(filename, sha256)
      ON expected.filename = applied.filename
   WHERE applied.sha256 <> expected.sha256;

  IF mismatch_count <> 0 THEN
    RAISE EXCEPTION 'SOL-43 convergence refused: historical migration checksum mismatch';
  END IF;
END
$$;

ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_email_key;

DROP INDEX IF EXISTS public.contacts_client_email_active_key;
DROP INDEX IF EXISTS public.contacts_client_email_identity_active_key;

CREATE UNIQUE INDEX contacts_client_email_identity_active_key
  ON public.contacts (
    client_id,
    lower(btrim(email)),
    lower(btrim(coalesce(first_name, ''))),
    lower(btrim(coalesce(last_name, '')))
  )
  WHERE client_id IS NOT NULL
    AND email IS NOT NULL
    AND btrim(email) <> ''
    AND archived_at IS NULL;

ALTER TABLE public.data_import_batches
  DROP CONSTRAINT IF EXISTS data_import_batches_entity_ck;

ALTER TABLE public.data_import_batches
  ADD CONSTRAINT data_import_batches_entity_ck CHECK (
    entity_type IN (
      'CLIENT',
      'CLIENT_ENRICHISSEMENT',
      'CLIENT_CONTACT',
      'FOURNISSEUR',
      'FOURNISSEUR_COMMANDE',
      'ARTICLE',
      'PIECE_TECHNIQUE',
      'MACHINE',
      'STOCK_INITIAL',
      'BL_HISTORIQUE',
      'EMPLOYE'
    )
  );

ALTER TABLE public.stock_movement_lines
  ALTER COLUMN qty TYPE numeric(18,6)
  USING qty::numeric(18,6);

ALTER TABLE public.stock_movement_lines
  DISABLE TRIGGER trg_protect_posted_stock_movement_line;

WITH opening_lines AS (
  SELECT
    line.id AS line_id,
    line.movement_id,
    line.qty AS old_line_qty,
    movement.qty AS posted_qty,
    COALESCE(movement.posted_by, movement.updated_by, movement.created_by, movement.user_id) AS actor_user_id,
    count(*) OVER (PARTITION BY line.movement_id) AS lines_count
  FROM public.stock_movement_lines AS line
  JOIN public.stock_movements AS movement ON movement.id = line.movement_id
  WHERE movement.status = 'POSTED'
    AND movement.source_document_type = 'CLIPPER_STOCK_OPENING'
), repaired AS (
  UPDATE public.stock_movement_lines AS line
     SET qty = opening_lines.posted_qty,
         updated_at = now(),
         updated_by = opening_lines.actor_user_id
    FROM opening_lines
   WHERE line.id = opening_lines.line_id
     AND opening_lines.lines_count = 1
     AND opening_lines.old_line_qty IS DISTINCT FROM opening_lines.posted_qty
     AND abs(opening_lines.old_line_qty - opening_lines.posted_qty) < 0.0005
  RETURNING
    opening_lines.movement_id,
    opening_lines.old_line_qty,
    opening_lines.posted_qty,
    opening_lines.actor_user_id
)
INSERT INTO public.stock_movement_event_log (
  id,
  stock_movement_id,
  event_type,
  old_values,
  new_values,
  user_id,
  created_by,
  updated_by
)
SELECT
  gen_random_uuid(),
  movement_id,
  'PRECISION_RECONCILED_198',
  jsonb_build_object('line_qty', old_line_qty),
  jsonb_build_object(
    'line_qty', posted_qty,
    'reason', 'SOL-43 production-safe convergence to NUMERIC(18,6)'
  ),
  actor_user_id,
  actor_user_id,
  actor_user_id
FROM repaired;

ALTER TABLE public.stock_movement_lines
  ENABLE TRIGGER trg_protect_posted_stock_movement_line;

CREATE TABLE IF NOT EXISTS public.cerp_migration_supersessions (
  legacy_filename text PRIMARY KEY,
  legacy_sha256 text NOT NULL CHECK (legacy_sha256 ~ '^[0-9a-f]{64}$'),
  replacement_filename text NOT NULL,
  database_name text NOT NULL,
  applied_by text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL
);

INSERT INTO public.cerp_migration_supersessions (
  legacy_filename,
  legacy_sha256,
  replacement_filename,
  database_name,
  applied_by,
  reason
)
VALUES
  ('20260727_contacts_email_scope_187.sql', '4d43141bc2e6b803f4b37d1dff146c9950e64c75f0b317194ebf03dacbddbf1a', '20260815_historical_test_guard_convergence_sol43.sql', current_database(), current_user, 'Legacy patch was restricted to cerp_test; final contact identity rule applied by SOL-43'),
  ('20260727_contacts_shared_email_identity_190.sql', 'b3b030cefbbf16ceca44481d74380de71803d72320c19b4da9cc62eee37aaf89', '20260815_historical_test_guard_convergence_sol43.sql', current_database(), current_user, 'Legacy patch was restricted to cerp_test; final contact identity rule applied by SOL-43'),
  ('20260727_import_supplier_orders_312.sql', '5988f518ebfe8160372ec833fb14fba636a54638f367a637703162032d7193a0', '20260815_historical_test_guard_convergence_sol43.sql', current_database(), current_user, 'Legacy patch was restricted to cerp_test; supplier-order import constraint applied by SOL-43'),
  ('20260727_stock_import_precision_198.sql', '0a348b7d6b723ba2d38b4927a5eed9a3999e3dfa82f56940f1f3a4d5b2da5a6a', '20260815_historical_test_guard_convergence_sol43.sql', current_database(), current_user, 'Legacy patch was restricted to cerp_test; stock precision and bounded repair applied by SOL-43')
ON CONFLICT (legacy_filename) DO UPDATE
SET legacy_sha256 = EXCLUDED.legacy_sha256,
    replacement_filename = EXCLUDED.replacement_filename,
    database_name = EXCLUDED.database_name,
    applied_by = EXCLUDED.applied_by,
    applied_at = now(),
    reason = EXCLUDED.reason;

INSERT INTO public.cerp_schema_migrations (filename, sha256)
VALUES
  ('20260727_contacts_email_scope_187.sql', '4d43141bc2e6b803f4b37d1dff146c9950e64c75f0b317194ebf03dacbddbf1a'),
  ('20260727_contacts_shared_email_identity_190.sql', 'b3b030cefbbf16ceca44481d74380de71803d72320c19b4da9cc62eee37aaf89'),
  ('20260727_import_supplier_orders_312.sql', '5988f518ebfe8160372ec833fb14fba636a54638f367a637703162032d7193a0'),
  ('20260727_stock_import_precision_198.sql', '0a348b7d6b723ba2d38b4927a5eed9a3999e3dfa82f56940f1f3a4d5b2da5a6a')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
