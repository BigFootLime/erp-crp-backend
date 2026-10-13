SET LOCAL ROLE cerp_app;
DO $$
DECLARE request_uuid uuid:=gen_random_uuid(); recovery_uuid uuid:=gen_random_uuid(); approval_uuid uuid:=gen_random_uuid(); blocked boolean;
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
    cancelled_by=1,cancelled_at=now(),cancellation_reason='Fixture annulation contrôlée',cancellation_retains_production=false,
    cancellation_evidence=jsonb_build_object('request',jsonb_build_object('id',request_uuid,'version',1,'status','WAITING_PLANNER'),'tree','[]'::jsonb)
    WHERE id=request_uuid;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='WAITING_PLANNER',version=3,
    cancelled_by=NULL,cancelled_at=NULL,cancellation_reason=NULL WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cancelled request silently reopened'; END IF;
  IF (SELECT qty_reserved FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001')<>4
    THEN RAISE EXCEPTION 'Donor reservation changed during preparation'; END IF;
  RAISE NOTICE 'URGENCY_CONSTRAINT_FIXTURE_PASS';

  SET CONSTRAINTS ALL DEFERRED;
  request_uuid:=gen_random_uuid(); recovery_uuid:=gen_random_uuid();
  INSERT INTO urgency_1033_fixture.delivery_urgency_requests
    (id,beneficiary_allocation_id,quantity,reason,preview_hash,snapshot,request_key,request_hash,created_by)
    VALUES(request_uuid,1,2,'Fixture demande à approuver',repeat('a',64),'{}',gen_random_uuid(),repeat('b',64),1);
  INSERT INTO urgency_1033_fixture.delivery_urgency_recoveries
    (id,request_id,donor_allocation_id,recovery_of_id,quantity,protected_due_date,initial_ar_due_date,donor_snapshot)
    VALUES(recovery_uuid,request_uuid,2,102,2,current_date+30,current_date+30,'{}');
  INSERT INTO urgency_1033_fixture.delivery_urgency_sources(recovery_id,donor_reservation_id,quantity,reservation_snapshot)
    VALUES(recovery_uuid,'dddddddd-0000-4000-8000-000000000001',2,'{}');
  SET CONSTRAINTS ALL IMMEDIATE;
  blocked:=false;
  BEGIN
    UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='APPROVED',version=2 WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Approval without evidence accepted'; END IF;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_approvals
      (request_id,request_version,preview_hash,planning_revision,evidence,response,request_key,request_hash,created_by)
      VALUES(request_uuid,99,repeat('c',64),7,'{}','{}',gen_random_uuid(),repeat('d',64),1);
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Stale approval accepted'; END IF;
  INSERT INTO urgency_1033_fixture.delivery_urgency_approvals
    (id,request_id,request_version,preview_hash,planning_revision,evidence,response,request_key,request_hash,created_by)
    VALUES(approval_uuid,request_uuid,1,repeat('c',64),7,'{}','{}',gen_random_uuid(),repeat('d',64),1);
  UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='APPROVED',version=2,approved_id=approval_uuid WHERE id=request_uuid;
  blocked:=false;
  BEGIN
    INSERT INTO urgency_1033_fixture.delivery_urgency_requests
      (beneficiary_allocation_id,quantity,reason,preview_hash,snapshot,request_key,request_hash,created_by)
      VALUES(1,2,'Fixture après approbation',repeat('a',64),'{}',gen_random_uuid(),repeat('b',64),1);
  EXCEPTION WHEN unique_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Approved request no longer protects beneficiary'; END IF;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_approvals SET evidence='{"changed":true}' WHERE id=approval_uuid;
  EXCEPTION WHEN insufficient_privilege OR object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Approval history mutable'; END IF;
  blocked:=false;
  BEGIN UPDATE urgency_1033_fixture.delivery_urgency_requests SET version=3 WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Old approval reused for a new version'; END IF;
  approval_uuid:=gen_random_uuid();
  INSERT INTO urgency_1033_fixture.delivery_urgency_approvals
    (id,request_id,request_version,preview_hash,planning_revision,evidence,response,request_key,request_hash,created_by)
    VALUES(approval_uuid,request_uuid,2,repeat('e',64),8,'{}','{}',gen_random_uuid(),repeat('f',64),1);
  UPDATE urgency_1033_fixture.delivery_urgency_requests SET version=3,approved_id=approval_uuid WHERE id=request_uuid;
  IF (SELECT count(*) FROM urgency_1033_fixture.delivery_urgency_approvals WHERE request_id=request_uuid)<>2
    THEN RAISE EXCEPTION 'Previous approval lost during renewal'; END IF;
  blocked:=false;
  BEGIN
    UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='CANCELLED',version=4,
      cancelled_by=1,cancelled_at=now(),cancellation_reason='Annulation avec preuve absente',cancellation_retains_production=true,
      cancellation_evidence='{}' WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Cancellation without review accepted'; END IF;
  blocked:=false;
  BEGIN
    UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='CANCELLED',version=4,
      cancelled_by=1,cancelled_at=now(),cancellation_reason='Annulation sans conservation',cancellation_retains_production=false,
      cancellation_evidence=jsonb_build_object('request',jsonb_build_object('id',request_uuid,'version',3,'status','APPROVED'),'tree','[]'::jsonb)
      WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Approved recovery silently abandoned'; END IF;
  blocked:=false;
  BEGIN
    UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='CANCELLED',version=4,approved_id=NULL,
      cancelled_by=1,cancelled_at=now(),cancellation_reason='Annulation qui perd approbation',cancellation_retains_production=true,
      cancellation_evidence=jsonb_build_object('request',jsonb_build_object('id',request_uuid,'version',3,'status','APPROVED'),'tree','[]'::jsonb)
      WHERE id=request_uuid;
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Approval identity erased during cancellation'; END IF;
  BEGIN
    UPDATE urgency_1033_fixture.delivery_urgency_requests SET status='CANCELLED',version=4,
      cancelled_by=1,cancelled_at=now(),cancellation_reason='Conserver fabrication validée',cancellation_retains_production=true,
      cancellation_evidence=jsonb_build_object('request',jsonb_build_object('id',request_uuid,'version',3,'status','APPROVED'),'tree','[]'::jsonb)
      WHERE id=request_uuid;
    IF NOT EXISTS(SELECT 1 FROM urgency_1033_fixture.delivery_urgency_requests WHERE id=request_uuid AND status='CANCELLED'
      AND cancellation_retains_production AND approved_id=approval_uuid AND withdrawn_id IS NULL) THEN
      RAISE EXCEPTION 'Reviewed cancellation lost history';
    END IF;
    RAISE EXCEPTION 'Rollback this successful cancellation to continue the withdrawal fixture' USING ERRCODE='P0002';
  EXCEPTION WHEN no_data_found THEN NULL; END;
  RAISE NOTICE 'URGENCY_RETAINED_CANCELLATION_FIXTURE_PASS';
  IF (SELECT qty_reserved FROM urgency_1033_fixture.stock_reservations WHERE id='dddddddd-0000-4000-8000-000000000001')<>4
    THEN RAISE EXCEPTION 'Approval withdrew donor stock'; END IF;
  RAISE NOTICE 'URGENCY_APPROVAL_FIXTURE_PASS';
END $$;
RESET ROLE;
