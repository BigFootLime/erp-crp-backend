SET LOCAL ROLE cerp_app;
SET CONSTRAINTS ALL DEFERRED;
DO $$
DECLARE request record; transfer record; recovery_uuid uuid; restore_uuid uuid:=gen_random_uuid(); charge_uuid uuid:=gen_random_uuid();
 movement_uuid uuid:=gen_random_uuid(); before_row jsonb; after_row jsonb; blocked boolean; wrong_uuid uuid:=gen_random_uuid();
BEGIN
 SELECT * INTO STRICT request FROM urgency_1033_fixture.delivery_urgency_requests WHERE status='WITHDRAWN';
 SELECT * INTO STRICT transfer FROM urgency_1033_fixture.delivery_urgency_transfers WHERE withdrawal_id=request.withdrawn_id;
 SELECT recovery_id INTO recovery_uuid FROM urgency_1033_fixture.delivery_urgency_sources WHERE id=transfer.source_id;
 INSERT INTO urgency_1033_fixture.delivery_urgency_order_charges VALUES(charge_uuid,1),(wrong_uuid,3);
 blocked:=false;
 BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_restitutions(request_id,withdrawal_id,request_version,charge_id,fee_decision,reason,evidence,response,preview_hash,request_key,request_hash,created_by)
  VALUES(request.id,request.withdrawn_id,request.version,wrong_uuid,'KEEP','Restitution de test','{}','{}',repeat('a',64),gen_random_uuid(),repeat('b',64),1);
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Wrong order charge accepted'; END IF;
 blocked:=false;
 BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_restitutions(request_id,withdrawal_id,request_version,charge_id,fee_decision,reason,evidence,response,preview_hash,request_key,request_hash,created_by)
  VALUES(request.id,request.withdrawn_id,request.version-1,charge_uuid,'KEEP','Restitution de test','{}','{}',repeat('a',64),gen_random_uuid(),repeat('b',64),1);
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Stale restitution accepted'; END IF;
 INSERT INTO urgency_1033_fixture.delivery_urgency_restitutions(id,request_id,withdrawal_id,request_version,charge_id,fee_decision,reason,evidence,response,preview_hash,request_key,request_hash,created_by)
 VALUES(restore_uuid,request.id,request.withdrawn_id,request.version,charge_uuid,'KEEP','Restitution de test','{}','{}',repeat('a',64),gen_random_uuid(),repeat('b',64),1);
 blocked:=false;
 BEGIN SET CONSTRAINTS ALL IMMEDIATE; EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Incomplete restitution could commit'; END IF;
 SELECT to_jsonb(r) INTO before_row FROM urgency_1033_fixture.stock_reservations r WHERE id=transfer.beneficiary_reservation_id;
 UPDATE urgency_1033_fixture.stock_reservations SET status='RELEASED',version=version+1 WHERE id=transfer.beneficiary_reservation_id;
 SELECT to_jsonb(r) INTO after_row FROM urgency_1033_fixture.stock_reservations r WHERE id=transfer.beneficiary_reservation_id;
 -- One unit was already replaced by the recovery OF: only one returns to the donor.
 INSERT INTO urgency_1033_fixture.delivery_urgency_replenishments VALUES(gen_random_uuid(),recovery_uuid,1);
 UPDATE urgency_1033_fixture.stock_reservations SET qty_reserved=qty_reserved+1 WHERE id=transfer.donor_reservation_id;
 blocked:=false;
 BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_restitution_lines(restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,reservation_evidence)
  VALUES(restore_uuid,transfer.id,transfer.donor_reservation_id,2,0,jsonb_build_object('before',before_row,'after',after_row));
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Replaced stock reserved twice'; END IF;
 INSERT INTO urgency_1033_fixture.stock_movements VALUES(movement_uuid,'DRAFT','TRANSFER','URGENCY_RESTITUTION',restore_uuid::text);
 INSERT INTO urgency_1033_fixture.stock_movement_lines VALUES(gen_random_uuid(),movement_uuid,
  'aaaaaaaa-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000001',1,
  'cccccccc-0000-4000-8000-000000000011','cccccccc-0000-4000-8000-000000000013');
 blocked:=false;
 BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_restitution_lines(restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,free_movement_id,reservation_evidence)
  VALUES(restore_uuid,transfer.id,transfer.donor_reservation_id,1,1,movement_uuid,jsonb_build_object('before',before_row,'after',after_row));
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Unposted surplus accepted'; END IF;
END $$;
RESET ROLE;
-- The stock service posts the transfer. This fixture only exercises journal guards.
UPDATE urgency_1033_fixture.stock_movements SET status='POSTED';
SET LOCAL ROLE cerp_app;
DO $$
DECLARE request record; restore record; transfer record; before_row jsonb; after_row jsonb; movement_uuid uuid; blocked boolean;
BEGIN
 SELECT * INTO STRICT request FROM urgency_1033_fixture.delivery_urgency_requests WHERE status='WITHDRAWN';
 SELECT * INTO STRICT restore FROM urgency_1033_fixture.delivery_urgency_restitutions WHERE request_id=request.id;
 SELECT * INTO STRICT transfer FROM urgency_1033_fixture.delivery_urgency_transfers WHERE withdrawal_id=request.withdrawn_id;
 SELECT id INTO STRICT movement_uuid FROM urgency_1033_fixture.stock_movements;
 SELECT to_jsonb(r) INTO after_row FROM urgency_1033_fixture.stock_reservations r WHERE id=transfer.beneficiary_reservation_id;
 before_row:=after_row || jsonb_build_object('status','ACTIVE','version',(after_row->>'version')::integer-1);
 blocked:=false;
 BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_restitution_lines(restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,free_movement_id,reservation_evidence)
  VALUES(restore.id,transfer.id,transfer.donor_reservation_id,1,1,movement_uuid,jsonb_build_object('before',before_row || '{"qty_prepared":1}'::jsonb,'after',after_row));
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Prepared stock returned silently'; END IF;
 blocked:=false;
 BEGIN
  INSERT INTO urgency_1033_fixture.delivery_urgency_restitution_lines(restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,free_movement_id,reservation_evidence)
  VALUES(restore.id,transfer.id,transfer.donor_reservation_id,1,1,movement_uuid,jsonb_build_object('before',before_row || '{"qty_consumed":1}'::jsonb,'after',after_row));
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Shipped stock returned without physical receipt'; END IF;
 INSERT INTO urgency_1033_fixture.delivery_urgency_restitution_lines(restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,free_movement_id,reservation_evidence)
 VALUES(restore.id,transfer.id,transfer.donor_reservation_id,1,1,movement_uuid,jsonb_build_object('before',before_row,'after',after_row));
 blocked:=false;
 BEGIN SET CONSTRAINTS ALL IMMEDIATE; EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Restored stock without cancellation could commit'; END IF;
 UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='CANCELLED',version=version+1,restitution_id=restore.id,
 cancelled_at=now(),cancelled_by=1,cancellation_reason=restore.reason,cancellation_retains_production=true,
 cancellation_evidence=jsonb_build_object('request',to_jsonb(request),'tree','[]'::jsonb) WHERE id=request.id;
 SET CONSTRAINTS ALL IMMEDIATE;
 IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.delivery_urgency_requests WHERE id=request.id AND approved_id=request.approved_id AND withdrawn_id=request.withdrawn_id)
 THEN RAISE EXCEPTION 'Original approval or withdrawal lost'; END IF;
 blocked:=false;
 BEGIN UPDATE urgency_1033_fixture.delivery_urgency_restitutions SET reason='Changed later' WHERE id=restore.id;
 EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Restitution header mutable'; END IF;
 blocked:=false;
 BEGIN DELETE FROM urgency_1033_fixture.delivery_urgency_restitution_lines WHERE restitution_id=restore.id;
 EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Restitution line removable'; END IF;
 blocked:=false;
 BEGIN
 INSERT INTO urgency_1033_fixture.delivery_urgency_restitution_lines(restitution_id,transfer_id,donor_reservation_id,donor_quantity,free_quantity,free_movement_id,reservation_evidence)
 VALUES(restore.id,transfer.id,transfer.donor_reservation_id,1,1,movement_uuid,jsonb_build_object('before',before_row,'after',after_row));
 EXCEPTION WHEN unique_violation OR check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Transfer restored twice'; END IF;
 RAISE NOTICE 'URGENCY_RESTITUTION_FIXTURE_PASS';
END $$;
RESET ROLE;
