SET LOCAL ROLE cerp_app;
DO $$
DECLARE charge uuid:='00000000-0000-4000-8000-000000000021';
  req uuid:='00000000-0000-4000-8000-000000000001';
  withdrawal uuid:='00000000-0000-4000-8000-000000000031';
  blocked boolean; statement text;
BEGIN
  INSERT INTO urgency_fee_1033_fixture.client_urgency_fee_settings(client_id,amount_ht,currency,updated_by) VALUES('C1',35.5,'EUR',1);
  PERFORM urgency_fee_1033_fixture.expect_rejected($q$UPDATE urgency_fee_1033_fixture.client_urgency_fee_settings SET amount_ht=-1$q$,'23514');
  INSERT INTO urgency_fee_1033_fixture.delivery_urgency_withdrawals VALUES(withdrawal,req);
  blocked:=false;
  BEGIN SET CONSTRAINTS ALL IMMEDIATE; EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Withdrawal without order charge accepted'; END IF;
  statement:=format('INSERT INTO urgency_fee_1033_fixture.delivery_urgency_order_charges(id,commande_id,client_id,request_id,withdrawal_id,amount_ht,currency,tax_rate_percent,settings_version,created_by) VALUES(%L,1,''C1'',%L,%L,35.50,''EUR'',20,1,1)',charge,req,withdrawal);
  PERFORM urgency_fee_1033_fixture.expect_rejected(replace(statement,'35.50','99.00'),'23514');
  PERFORM urgency_fee_1033_fixture.expect_rejected(replace(statement,'''C1''','''C2'''),'23514');
  EXECUTE statement;
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO urgency_fee_1033_fixture.delivery_urgency_withdrawals
    VALUES('00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000002');
  PERFORM urgency_fee_1033_fixture.expect_rejected(replace(replace(statement,charge::text,gen_random_uuid()::text),withdrawal::text,'00000000-0000-4000-8000-000000000032'),'23505');
  PERFORM urgency_fee_1033_fixture.expect_rejected('UPDATE urgency_fee_1033_fixture.delivery_urgency_order_charges SET amount_ht=1','42501');
  PERFORM urgency_fee_1033_fixture.expect_rejected('DELETE FROM urgency_fee_1033_fixture.delivery_urgency_order_charges','42501');
  UPDATE urgency_fee_1033_fixture.client_urgency_fee_settings SET amount_ht=99,version=2;
  IF (SELECT amount_ht FROM urgency_fee_1033_fixture.delivery_urgency_order_charges WHERE id=charge)<>35.5 THEN
    RAISE EXCEPTION 'Changed client setting rewrote accepted charge'; END IF;
  INSERT INTO urgency_fee_1033_fixture.facture_ligne
    SELECT id,id,1,35.5,0,20,35.5,42.6,7.1,jsonb_build_object('source_type','ORDER_CHARGE','source_line_id',charge,'source_id','1')
    FROM urgency_fee_1033_fixture.facture;
  FOR n IN 2..5 LOOP
    PERFORM urgency_fee_1033_fixture.expect_rejected(format('INSERT INTO urgency_fee_1033_fixture.facture_urgency_charges VALUES(%L,%s,%s,1,now())',charge,n,n),
      CASE WHEN n=5 THEN '55000' ELSE '23514' END);
  END LOOP;
  UPDATE urgency_fee_1033_fixture.facture_ligne SET total_ttc=99 WHERE id=1;
  PERFORM urgency_fee_1033_fixture.expect_rejected(format('INSERT INTO urgency_fee_1033_fixture.facture_urgency_charges VALUES(%L,1,1,1,now())',charge),'23514');
  UPDATE urgency_fee_1033_fixture.facture_ligne SET total_ttc=42.6 WHERE id=1;
  INSERT INTO urgency_fee_1033_fixture.facture_urgency_charges VALUES(charge,1,1,1,now());
  INSERT INTO urgency_fee_1033_fixture.facture_source_allocations VALUES(2,'DELIVERY_LINE','00000000-0000-4000-8000-000000000012');
  PERFORM urgency_fee_1033_fixture.expect_rejected(format('INSERT INTO urgency_fee_1033_fixture.facture_urgency_charges VALUES(%L,2,2,1,now())',charge),'23505');
  PERFORM urgency_fee_1033_fixture.expect_rejected('UPDATE urgency_fee_1033_fixture.facture_ligne SET prix_unitaire_ht=99 WHERE id=1','55000');
  PERFORM urgency_fee_1033_fixture.expect_rejected('DELETE FROM urgency_fee_1033_fixture.facture_ligne WHERE id=1','55000');
  PERFORM urgency_fee_1033_fixture.expect_rejected('DELETE FROM urgency_fee_1033_fixture.facture_urgency_charges','42501');
  UPDATE urgency_fee_1033_fixture.facture SET document_status='ISSUED',statut='ISSUED' WHERE id=1;
  IF (SELECT count(*) FROM urgency_fee_1033_fixture.delivery_urgency_order_charges)<>1
    OR (SELECT count(*) FROM urgency_fee_1033_fixture.facture_urgency_charges)<>1 THEN RAISE EXCEPTION 'Fee counted twice'; END IF;
  RAISE NOTICE 'URGENCY_FEE_FIXTURE_PASS';
END $$;
RESET ROLE;
