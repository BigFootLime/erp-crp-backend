-- Runs after the approval fixture, using its approved request. All data is synthetic and rolled back.
SET LOCAL ROLE cerp_app;
SET CONSTRAINTS ALL DEFERRED;
DO $$
DECLARE request record; source_uuid uuid; withdrawal_uuid uuid:=gen_random_uuid(); blocked boolean;
  destination uuid:='dddddddd-0000-4000-8000-000000000003';
  donor uuid:='dddddddd-0000-4000-8000-000000000001';
BEGIN
  SELECT * INTO STRICT request FROM urgency_1033_fixture.delivery_urgency_requests WHERE status='APPROVED';
  SELECT source.id INTO STRICT source_uuid FROM urgency_1033_fixture.delivery_urgency_sources source
    JOIN urgency_1033_fixture.delivery_urgency_recoveries recovery ON recovery.id=source.recovery_id WHERE recovery.request_id=request.id;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_withdrawals
      (request_id,approval_id,request_version,quantity,preview_hash,evidence,response,request_key,request_hash,created_by)
      VALUES(request.id,request.approved_id,request.version-1,2,repeat('a',64),'{}','{}',gen_random_uuid(),repeat('b',64),1);
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Stale withdrawal accepted'; END IF;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='WITHDRAWN',version=version+1 WHERE id=request.id;
  EXCEPTION WHEN check_violation OR object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Withdrawal without evidence accepted'; END IF;
  INSERT INTO urgency_1033_fixture.delivery_urgency_withdrawals
    (id,request_id,approval_id,request_version,quantity,preview_hash,evidence,response,request_key,request_hash,created_by)
    VALUES(withdrawal_uuid,request.id,request.approved_id,request.version,2,repeat('a',64),'{}','{}',gen_random_uuid(),repeat('b',64),1);
  blocked:=false;
  BEGIN SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Unfinished withdrawal could commit'; END IF;
  INSERT INTO urgency_1033_fixture.stock_reservations
    (id,commande_ligne_affaire_allocation_id,location_id,status,qty_reserved,qty_consumed,qty_prepared)
    VALUES(destination,1,'cccccccc-0000-4000-8000-000000000001','ACTIVE',2,0,0);
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_transfers
      (withdrawal_id,source_id,donor_reservation_id,beneficiary_reservation_id,quantity,reservation_evidence)
      VALUES(withdrawal_uuid,source_uuid,donor,destination,1,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Partial ledger quantity accepted'; END IF;
  UPDATE urgency_1033_fixture.stock_reservations SET lot_id=gen_random_uuid() WHERE id=destination;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_transfers
      (withdrawal_id,source_id,donor_reservation_id,beneficiary_reservation_id,quantity,reservation_evidence)
      VALUES(withdrawal_uuid,source_uuid,donor,destination,2,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Lot identity lost during withdrawal'; END IF;
  UPDATE urgency_1033_fixture.stock_reservations SET lot_id='eeeeeeee-0000-4000-8000-000000000001',commande_ligne_affaire_allocation_id=3 WHERE id=destination;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_transfers
      (withdrawal_id,source_id,donor_reservation_id,beneficiary_reservation_id,quantity,reservation_evidence)
      VALUES(withdrawal_uuid,source_uuid,donor,destination,2,'{}');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Transfer to another client accepted'; END IF;
  UPDATE urgency_1033_fixture.stock_reservations SET commande_ligne_affaire_allocation_id=1 WHERE id=destination;
  UPDATE urgency_1033_fixture.stock_reservations SET qty_reserved=qty_reserved-2 WHERE id=donor;
  INSERT INTO urgency_1033_fixture.delivery_urgency_transfers
    (withdrawal_id,source_id,donor_reservation_id,beneficiary_reservation_id,quantity,reservation_evidence)
    VALUES(withdrawal_uuid,source_uuid,donor,destination,2,'{}');
  blocked:=false;
  BEGIN SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Transferred request could remain open'; END IF;
  UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='WITHDRAWN',version=version+1,withdrawn_id=withdrawal_uuid WHERE id=request.id;
  SET CONSTRAINTS ALL IMMEDIATE;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_transfers SET quantity=1 WHERE withdrawal_id=withdrawal_uuid;
  EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Transfer evidence mutable'; END IF;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='APPROVED',version=version+1,withdrawn_id=NULL WHERE id=request.id;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Withdrawn request silently reopened'; END IF;
  IF (SELECT sum(qty_reserved-qty_consumed) FROM urgency_1033_fixture.stock_reservations WHERE id IN(donor,destination))<>4
    THEN RAISE EXCEPTION 'Reassignment changed total reserved quantity'; END IF;
  RAISE NOTICE 'URGENCY_WITHDRAWAL_FIXTURE_PASS';
END $$;
RESET ROLE;
