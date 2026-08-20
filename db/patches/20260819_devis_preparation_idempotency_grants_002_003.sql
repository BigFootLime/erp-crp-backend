-- CERP-AUDIT-002/003 — minimum runtime privileges for quote preparation and
-- idempotent creation. No business data, ownership, or existing grants change.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  target_relation text;
BEGIN
  IF current_database() NOT IN ('cerp_test', 'cerp_prod')
     AND current_database() !~ '^cerp_restore_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'CERP-AUDIT-002/003 grant refused on database %', current_database();
  END IF;

  FOREACH target_relation IN ARRAY ARRAY[
    'public.article_devis',
    'public.dossier_technique_piece_devis',
    'public.devis_idempotence'
  ] LOOP
    IF to_regclass(target_relation) IS NULL THEN
      RAISE EXCEPTION 'CERP-AUDIT-002/003 grant refused: relation % is missing', target_relation;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cerp_app') THEN
    RAISE EXCEPTION 'CERP-AUDIT-002/003 grant refused: runtime role cerp_app is missing';
  END IF;
END
$guard$;

-- Repository evidence: preparation rows are selected/inserted/deleted when a
-- draft is replaced; the idempotency ledger is only selected/inserted.
GRANT SELECT, INSERT, DELETE ON TABLE public.article_devis TO cerp_app;
GRANT SELECT, INSERT, DELETE ON TABLE public.dossier_technique_piece_devis TO cerp_app;
GRANT SELECT, INSERT ON TABLE public.devis_idempotence TO cerp_app;

COMMIT;
