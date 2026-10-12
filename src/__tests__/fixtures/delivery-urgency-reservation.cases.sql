-- The harness prepares urgency_release from the actual repository UPDATE statement.
-- Nothing is persisted; each scenario uses the same isolated donor fixture.
SET LOCAL ROLE cerp_app;
EXECUTE urgency_release('dddddddd-0000-4000-8000-000000000001',0.125,1,1);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001'
    AND qty_reserved=3.875 AND status='ACTIVE' AND version=2) THEN RAISE EXCEPTION 'Decimal partial withdrawal failed'; END IF;
END $$;
EXECUTE urgency_release('dddddddd-0000-4000-8000-000000000001',1,1,1);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001'
    AND qty_reserved=3.875 AND version=2) THEN RAISE EXCEPTION 'Stale version changed donor'; END IF;
END $$;
UPDATE urgency_1033_fixture.stock_reservations SET qty_reserved=4,qty_consumed=1,qty_prepared=2 WHERE id='dddddddd-0000-4000-8000-000000000001';
EXECUTE urgency_release('dddddddd-0000-4000-8000-000000000001',1.001,1,2);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001'
    AND qty_reserved=4 AND qty_prepared=2 AND qty_consumed=1 AND version=2) THEN RAISE EXCEPTION 'Prepared/shipped quantities were borrowed'; END IF;
END $$;
EXECUTE urgency_release('dddddddd-0000-4000-8000-000000000001',1,1,2);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001'
    AND qty_reserved=3 AND qty_prepared=2 AND qty_consumed=1 AND status='ACTIVE' AND version=3) THEN RAISE EXCEPTION 'Prepared coverage not retained'; END IF;
END $$;
UPDATE urgency_1033_fixture.stock_reservations SET qty_prepared=0 WHERE id='dddddddd-0000-4000-8000-000000000001';
EXECUTE urgency_release('dddddddd-0000-4000-8000-000000000001',2,1,3);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001'
    AND qty_reserved=1 AND qty_consumed=1 AND status='CONSUMED' AND version=4) THEN RAISE EXCEPTION 'Consumed historical quantity lost'; END IF;
END $$;
UPDATE urgency_1033_fixture.stock_reservations SET status='ACTIVE',qty_reserved=4,qty_consumed=0 WHERE id='dddddddd-0000-4000-8000-000000000001';
EXECUTE urgency_release('dddddddd-0000-4000-8000-000000000001',4,1,4);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001'
    AND qty_reserved=4 AND status='RELEASED' AND version=5 AND released_by=1 AND released_at IS NOT NULL)
    THEN RAISE EXCEPTION 'Full withdrawal did not retain historical reservation'; END IF;
  RAISE NOTICE 'URGENCY_RESERVATION_UPDATE_PASS';
END $$;
RESET ROLE;
