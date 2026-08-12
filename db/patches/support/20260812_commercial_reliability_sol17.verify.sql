\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  expected_sha256 constant text := '9da8fc1d7a71a5cf1133995de85d2c2680eeec5f7d7ffbcaa826351d8f35e97e';
  registered_sha256 text;
  owner_count integer;
  trigger_count integer;
BEGIN
  SELECT sha256 INTO registered_sha256
  FROM public.cerp_schema_migrations
  WHERE filename='20260812_commercial_reliability_sol17.sql';
  IF registered_sha256 IS DISTINCT FROM expected_sha256 THEN
    RAISE EXCEPTION 'SOL-17 verify: exact migration checksum is not registered';
  END IF;
  IF to_regclass('public.commercial_quote_events') IS NULL
     OR to_regclass('public.commercial_order_cancellations') IS NULL
     OR to_regclass('public.commercial_command_receipts') IS NULL THEN
    RAISE EXCEPTION 'SOL-17 verify: one or more target tables are missing';
  END IF;

  SELECT COUNT(*)::integer INTO owner_count
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=ANY(ARRAY[
    'commercial_quote_events','commercial_order_cancellations','commercial_command_receipts'
  ]) AND c.relowner=to_regrole('cerp_app');
  IF owner_count<>3 THEN
    RAISE EXCEPTION 'SOL-17 verify: runtime ownership is not exact';
  END IF;

  SELECT COUNT(*)::integer INTO trigger_count
  FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND tgname=ANY(ARRAY[
    'commercial_quote_events_append_only','commercial_order_cancellations_append_only',
    'commercial_command_receipts_append_only'
  ]);
  IF trigger_count<>3 THEN
    RAISE EXCEPTION 'SOL-17 verify: append-only triggers are missing or disabled';
  END IF;

  IF EXISTS (
    SELECT action,idempotency_key FROM public.commercial_command_receipts
    GROUP BY action,idempotency_key HAVING COUNT(*)>1
  ) THEN
    RAISE EXCEPTION 'SOL-17 verify: idempotency receipt uniqueness is violated';
  END IF;
  IF EXISTS (
    SELECT devis_id,channel,(occurred_at AT TIME ZONE 'Europe/Paris')::date
    FROM public.commercial_quote_events WHERE event_type='REMINDER_RECORDED'
    GROUP BY devis_id,channel,(occurred_at AT TIME ZONE 'Europe/Paris')::date HAVING COUNT(*)>1
  ) THEN
    RAISE EXCEPTION 'SOL-17 verify: duplicate daily quote reminders exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.commercial_quote_events
    WHERE event_type='LOST' AND reason_code IS NULL
  ) THEN
    RAISE EXCEPTION 'SOL-17 verify: a quote loss lacks a structured reason';
  END IF;
  IF EXISTS (
    SELECT devis_id,quote_content_hash FROM public.commercial_quote_events
    WHERE event_type='DISCOUNT_REQUESTED'
    GROUP BY devis_id,quote_content_hash HAVING COUNT(*)>1
  ) THEN
    RAISE EXCEPTION 'SOL-17 verify: duplicate discount requests exist for one quote version';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.commercial_order_cancellations c
    WHERE NOT EXISTS (
      SELECT 1 FROM public.commande_historique h
      WHERE h.commande_id=c.commande_id AND h.nouveau_statut='ANNULE'
    )
  ) THEN
    RAISE EXCEPTION 'SOL-17 verify: an order cancellation lacks status history';
  END IF;
END
$verify$;

ROLLBACK;
