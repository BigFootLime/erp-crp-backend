SET LOCAL ROLE cerp_app;
DO $$
DECLARE request_uuid uuid:=gen_random_uuid(); recovery_uuid uuid:=gen_random_uuid(); blocked boolean;
BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_requests
    (id,beneficiary_allocation_id,quantity,reason,preview_hash,snapshot,request_key,request_hash,created_by)
    VALUES(request_uuid,1,2,'Fixture demande urgente',repeat('a',64),'{}',gen_random_uuid(),repeat('b',64),1);
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_requests
      (beneficiary_allocation_id,quantity,reason,preview_hash,snapshot,request_key,request_hash,created_by)
      VALUES(1,2,'Fixture demande doublon',repeat('a',64),'{}',gen_random_uuid(),repeat('b',64),1);
  EXCEPTION WHEN unique_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Duplicate active request accepted'; END IF;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_recoveries
      (request_id,donor_allocation_id,recovery_of_id,quantity,protected_due_date,initial_ar_due_date,donor_snapshot)
      VALUES(request_uuid,3,101,2,current_date+30,current_date+30,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cross-client recovery accepted'; END IF;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_recoveries
      (request_id,donor_allocation_id,recovery_of_id,quantity,protected_due_date,initial_ar_due_date,donor_snapshot)
      VALUES(request_uuid,1,101,2,current_date+30,current_date+30,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Same-affair recovery accepted'; END IF;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_recoveries
      (request_id,donor_allocation_id,recovery_of_id,quantity,protected_due_date,initial_ar_due_date,donor_snapshot)
      VALUES(request_uuid,2,101,3,current_date+30,current_date+30,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Wrong OF quantity accepted'; END IF;
  INSERT INTO urgency_1033_fixture.delivery_urgency_recoveries
    (id,request_id,donor_allocation_id,recovery_of_id,quantity,protected_due_date,initial_ar_due_date,donor_snapshot)
    VALUES(recovery_uuid,request_uuid,2,101,2,current_date+30,current_date+30,'{}');
  blocked:=false;
  BEGIN SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Missing source quantities accepted'; END IF;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_sources(recovery_id,donor_reservation_id,quantity,reservation_snapshot)
      VALUES(recovery_uuid,'dddddddd-0000-4000-8000-000000000002',2,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Assembly lane donor accepted'; END IF;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_sources(recovery_id,donor_reservation_id,quantity,reservation_snapshot)
      VALUES(recovery_uuid,'dddddddd-0000-4000-8000-000000000001',5,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Overcommitted donor accepted'; END IF;
  INSERT INTO urgency_1033_fixture.delivery_urgency_sources(recovery_id,donor_reservation_id,quantity,reservation_snapshot)
    VALUES(recovery_uuid,'dddddddd-0000-4000-8000-000000000001',2,'{}');
  SET CONSTRAINTS ALL IMMEDIATE;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_requests SET quantity=3 WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Request evidence was mutable'; END IF;
  UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='CANCELLED',version=2,
    cancelled_by=1,cancelled_at=now(),cancellation_reason='Fixture annulation contrôlée' WHERE id=request_uuid;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='WAITING_PLANNER',version=3,
    cancelled_by=NULL,cancelled_at=NULL,cancellation_reason=NULL WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cancelled request silently reopened'; END IF;
  IF (SELECT qty_reserved FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001')<>4
    THEN RAISE EXCEPTION 'Donor reservation changed during preparation'; END IF;
  RAISE NOTICE 'URGENCY_CONSTRAINT_FIXTURE_PASS';
END $$;
RESET ROLE;
