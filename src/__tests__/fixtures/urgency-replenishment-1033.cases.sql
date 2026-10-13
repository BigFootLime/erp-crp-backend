SET LOCAL ROLE cerp_app;
SET LOCAL search_path=urgency_replenishment_1033_fixture,pg_catalog;
DO $$
<<fixture>>
DECLARE request_id uuid:=gen_random_uuid(); recovery_id uuid:=gen_random_uuid(); grouped_id uuid:=gen_random_uuid();
  lot_id uuid:=gen_random_uuid(); other_lot uuid:=gen_random_uuid(); reservation_id uuid:=gen_random_uuid();
  other_reservation uuid:=gen_random_uuid(); receipt_id uuid:=gen_random_uuid(); grouped_receipt uuid:=gen_random_uuid();
  movement_id uuid:=gen_random_uuid(); group_movement uuid:=gen_random_uuid(); group_id uuid:=gen_random_uuid();
  allocation_id uuid:=gen_random_uuid(); relocated_reservation uuid:=gen_random_uuid();
  insert_sql text; group_sql text; distribution jsonb; amount numeric;
BEGIN
  INSERT INTO users VALUES(1);
  INSERT INTO delivery_urgency_requests VALUES(request_id,'WITHDRAWN');
  INSERT INTO delivery_urgency_recoveries VALUES(recovery_id,request_id,11,101,20),(grouped_id,request_id,11,102,20);
  INSERT INTO lots VALUES(lot_id),(other_lot);
  INSERT INTO stock_reservations VALUES(reservation_id,11,lot_id,'ACTIVE',50,0),(other_reservation,12,lot_id,'ACTIVE',50,0);
  INSERT INTO stock_movements VALUES(movement_id,'POSTED'),(group_movement,'POSTED');
  INSERT INTO of_receipts VALUES(receipt_id,101,movement_id,lot_id,25),(grouped_receipt,200,group_movement,lot_id,50);
  INSERT INTO production_consolidations VALUES(group_id,200);
  INSERT INTO production_consolidation_allocations VALUES(allocation_id,group_id,102);
  INSERT INTO production_consolidation_receipt_allocations VALUES(allocation_id,group_movement,lot_id,5);
  distribution:=jsonb_build_object('received_quantity','25','destinations',jsonb_build_array(
    jsonb_build_object('lane','DELIVERY','quantity','7.125','reservations',jsonb_build_array(
      jsonb_build_object('reservation_id',relocated_reservation,'source_reservation_id',reservation_id,'quantity','7.125'))),
    jsonb_build_object('lane','FREE','quantity','17.875','reservations','[]'::jsonb)));
  INSERT INTO production_receipt_lane_assignments(receipt_id,distribution) VALUES(receipt_id,distribution);
  INSERT INTO production_receipt_lane_assignments(receipt_id,distribution) VALUES(grouped_receipt,distribution);
  insert_sql:=format('INSERT INTO delivery_urgency_replenishments(recovery_id,receipt_id,reservation_id,lot_id,quantity,created_by) VALUES(%L,%L,%L,%L,',recovery_id,receipt_id,reservation_id,lot_id);
  group_sql:=format('INSERT INTO delivery_urgency_replenishments(recovery_id,receipt_id,reservation_id,lot_id,quantity,created_by) VALUES(%L,%L,%L,%L,',grouped_id,grouped_receipt,reservation_id,lot_id);
  PERFORM expect_rejected(insert_sql||'-1,1)','23514');
  UPDATE delivery_urgency_requests SET status='APPROVED';
  PERFORM expect_rejected(insert_sql||'1,1)','23514');
  UPDATE delivery_urgency_requests SET status='WITHDRAWN';
  PERFORM expect_rejected(replace(insert_sql,reservation_id::text,other_reservation::text)||'1,1)','23514');
  PERFORM expect_rejected(replace(insert_sql,lot_id::text,other_lot::text)||'1,1)','23514');
  UPDATE stock_reservations SET status='RELEASED' WHERE id=reservation_id;
  PERFORM expect_rejected(insert_sql||'1,1)','23514');
  UPDATE stock_reservations SET status='ACTIVE' WHERE id=reservation_id;
  UPDATE stock_movements SET status='DRAFT' WHERE id=movement_id;
  PERFORM expect_rejected(insert_sql||'1,1)','23514');
  UPDATE stock_movements SET status='POSTED' WHERE id=movement_id;
  UPDATE of_receipts SET of_id=999 WHERE id=receipt_id;
  PERFORM expect_rejected(insert_sql||'1,1)','23514');
  UPDATE of_receipts SET of_id=101 WHERE id=receipt_id;
  PERFORM expect_rejected(insert_sql||'8,1)','23514'); -- Free/quarantined output is not repayment.
  PERFORM expect_rejected(group_sql||'6,1)','23514'); -- Another grouped source's output is not repayment.
  EXECUTE insert_sql||'7.125,1)'; SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM expect_rejected(insert_sql||'0.001,1)','23514'); -- Same released attribution cannot be replayed.
  EXECUTE group_sql||'5,1)'; SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  -- A second actual Quality release restores only its additional entitlement.
  distribution:=jsonb_build_object('received_quantity','12.875','destinations',jsonb_build_array(
    jsonb_build_object('lane','DELIVERY','quantity','12.875','reservations',jsonb_build_array(
      jsonb_build_object('reservation_id',reservation_id,'quantity','12.875')))));
  INSERT INTO production_receipt_lane_assignments(receipt_id,distribution) VALUES(receipt_id,distribution);
  EXECUTE insert_sql||'12.875,1)'; SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM expect_rejected(insert_sql||'0.001,1)','23514'); -- Borrowed quantity cap, regardless of surplus.
  SELECT sum(quantity) INTO amount FROM delivery_urgency_replenishments p WHERE p.recovery_id=fixture.recovery_id;
  IF amount<>20 THEN RAISE EXCEPTION 'Exact partial recovery failed: %',amount; END IF;
  PERFORM expect_rejected('UPDATE delivery_urgency_replenishments SET quantity=1','42501');
  PERFORM expect_rejected('DELETE FROM delivery_urgency_replenishments','42501');
  RAISE NOTICE 'URGENCY_REPLENISHMENT_FIXTURE_PASS';
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
RESET ROLE;
