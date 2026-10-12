\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'material_bars_1246' THEN RAISE EXCEPTION 'Isolated fixture database required'; END IF;
END $$;
SET ROLE cerp_app;
BEGIN;
INSERT INTO public.users VALUES (1246);
INSERT INTO public.stock_batches VALUES (fixture_id_1246('batch-a'),NULL,NULL,3000,300),(fixture_id_1246('batch-b'),NULL,NULL,1000,50);
INSERT INTO public.stock_reservations(id,stock_batch_id,qty_reserved,qty_consumed,status,expires_at) VALUES
  (fixture_id_1246('reservation-a'),fixture_id_1246('batch-a'),200,0,'ACTIVE',NULL),
  (fixture_id_1246('reservation-b'),fixture_id_1246('batch-a'),100,0,'ACTIVE',NULL),
  (fixture_id_1246('reservation-c'),fixture_id_1246('batch-b'),50,0,'ACTIVE',NULL);
INSERT INTO public.stock_material_bar_inventories(stock_batch_id,movement_count,confirmed_by,note)
  VALUES (fixture_id_1246('batch-a'),0,1246,'Three measured bars');
INSERT INTO public.stock_material_bars(id,stock_batch_id,initial_length_mm,remaining_length_mm,created_by,updated_by)
  SELECT fixture_id_1246('bar-'||n),fixture_id_1246('batch-a'),1000,1000,1246,1246 FROM generate_series(1,3) n;
INSERT INTO public.stock_material_bar_reservations(bar_id,reservation_id,remaining_length_mm,updated_by) VALUES
  (fixture_id_1246('bar-1'),fixture_id_1246('reservation-a'),200,1246),
  (fixture_id_1246('bar-1'),fixture_id_1246('reservation-b'),100,1246);
COMMIT;

-- Each failure rolls back its subtransaction, including deferred trigger events.
-- An unexpected success raises P0001 and therefore cannot satisfy this assertion.
CREATE FUNCTION pg_temp.expect_check_1246(label text, commands text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE commands;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Expected check violation: %',label;
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: %',label;
  END;
END $$;
SELECT pg_temp.expect_check_1246('cannot reserve more than a physical bar', $q$
  UPDATE public.stock_reservations SET qty_reserved=1100 WHERE id=fixture_id_1246('reservation-a');
  UPDATE public.stock_material_bar_reservations SET remaining_length_mm=1100 WHERE reservation_id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('cannot allocate to another batch', $q$
  INSERT INTO public.stock_material_bar_reservations VALUES(fixture_id_1246('bar-2'),fixture_id_1246('reservation-c'),50,now(),1246);
$q$);
SELECT pg_temp.expect_check_1246('bar allocations must equal canonical remaining reservation', $q$
  UPDATE public.stock_material_bar_reservations SET remaining_length_mm=199 WHERE reservation_id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('canonical changes cannot leave allocations stale', $q$
  UPDATE public.stock_reservations SET qty_consumed=1 WHERE id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('cancel cannot leave a live bar hold', $q$
  UPDATE public.stock_reservations SET status='CANCELLED' WHERE id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('deleting a hold cannot lose canonical reserved stock', $q$
  DELETE FROM public.stock_material_bar_reservations WHERE reservation_id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('retired bars cannot retain allocations', $q$
  UPDATE public.stock_material_bars SET retired_at=now() WHERE id=fixture_id_1246('bar-1');
$q$);
SELECT pg_temp.expect_check_1246('bar identity cannot change', $q$
  UPDATE public.stock_material_bars SET initial_length_mm=2000 WHERE id=fixture_id_1246('bar-1');
$q$);
SELECT pg_temp.expect_check_1246('hold identity cannot bypass checks on the old reservation', $q$
  UPDATE public.stock_material_bar_reservations SET reservation_id=fixture_id_1246('reservation-b'),bar_id=fixture_id_1246('bar-2') WHERE reservation_id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('canonical batch cannot move away from its bar', $q$
  UPDATE public.stock_reservations SET stock_batch_id=fixture_id_1246('batch-b') WHERE id=fixture_id_1246('reservation-a');
$q$);
SELECT pg_temp.expect_check_1246('a cut requires its canonical stock movement', $q$
  INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,after_state,reason,created_by)
    VALUES(fixture_id_1246('bar-1'),fixture_id_1246('bad-cut'),'CUT','{}','Fixture cut',1246);
$q$);

-- Geometry and canonical stock can change together in one transaction.
BEGIN;
UPDATE public.stock_material_bars SET remaining_length_mm=900,row_version=row_version+1 WHERE id=fixture_id_1246('bar-1');
UPDATE public.stock_material_bar_reservations SET remaining_length_mm=100 WHERE reservation_id=fixture_id_1246('reservation-a');
UPDATE public.stock_reservations SET qty_consumed=100 WHERE id=fixture_id_1246('reservation-a');
UPDATE public.stock_batches SET qty_total=2900,qty_reserved=200 WHERE id=fixture_id_1246('batch-a');
INSERT INTO public.stock_movements VALUES(fixture_id_1246('cut'),fixture_id_1246('batch-a'),'POSTED');
UPDATE public.stock_material_bar_inventories SET movement_count=1,row_version=row_version+1 WHERE stock_batch_id=fixture_id_1246('batch-a');
INSERT INTO public.stock_material_bar_events(bar_id,command_key,action,stock_movement_id,before_state,after_state,reason,created_by)
 VALUES(fixture_id_1246('bar-1'),fixture_id_1246('cut-command'),'CUT',fixture_id_1246('cut'),'{"lengthMm":1000}','{"lengthMm":900}','Fixture debit',1246);
COMMIT;
SELECT pg_temp.expect_check_1246('events cannot be edited', $q$
  UPDATE public.stock_material_bar_events SET reason='Overwritten fixture';
$q$);
SELECT pg_temp.expect_check_1246('events cannot be deleted', $q$
  DELETE FROM public.stock_material_bar_events;
$q$);
DO $$ BEGIN
  IF (SELECT remaining_length_mm FROM public.stock_material_bars WHERE id=fixture_id_1246('bar-1'))<>900
    OR (SELECT remaining_length_mm FROM public.stock_material_bar_reservations WHERE reservation_id=fixture_id_1246('reservation-a'))<>100
    OR (SELECT count(*) FROM public.stock_material_bar_events)<>1 THEN
    RAISE EXCEPTION 'Atomic debit changed unexpected data';
  END IF;
  RAISE NOTICE 'PASS: atomic debit preserves the other OF hold and records one immutable event';
END $$;
RESET ROLE;
