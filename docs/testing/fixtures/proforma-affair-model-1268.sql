\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN
  IF current_database() NOT LIKE 'cerp_qualify_1268_%' THEN
    RAISE EXCEPTION 'Synthetic proforma qualification requires its dedicated isolated database';
  END IF;
END $$;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='5s';
-- A schema-only restore omits the singleton seeds installed by planning migrations.
-- Restore those defaults in this isolated transaction; keep every trigger enabled.
INSERT INTO public.planning_central_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO public.planning_forecast_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO public.planning_learning_state(singleton) VALUES(true) ON CONFLICT DO NOTHING;
INSERT INTO public.users(id,username,password,name,surname,email,role)
  VALUES(7,'QUAL1268','ISOLATED_TEST_LOGIN_DISABLED','Qualification','Proforma','qualification@example.invalid','Directeur');
-- Client identity is assigned by the existing trigger, even when supplied explicitly.
INSERT INTO public.clients(company_name,client_code) VALUES('Qualification client','901')
  RETURNING client_id AS customer_id \gset
INSERT INTO public.clients(company_name,client_code) VALUES('Qualification société A','902')
  RETURNING client_id AS billed_a_id \gset
INSERT INTO public.clients(company_name,client_code) VALUES('Qualification société B','903')
  RETURNING client_id AS billed_b_id \gset
INSERT INTO public.commande_client(id,numero,client_id,order_type)
  VALUES(1268001,'QUAL1268-CMD',:'customer_id','FERME');
INSERT INTO public.commande_ligne(id,commande_id,designation,prix_unitaire_ht,remise_ligne,taux_tva)
  VALUES(1268001,1268001,'Article fictif qualification',10,0,20);
INSERT INTO public.affaire(id,reference) VALUES(1268001,'QUAL1268-AFFAIRE');
INSERT INTO public.commande_ligne_affaire_allocation(id,commande_id,commande_ligne_id,livraison_affaire_id,qty_ordered)
  VALUES(1268001,1268001,1268001,1268001,100);
INSERT INTO public.commande_ligne(id,commande_id,designation,prix_unitaire_ht,remise_ligne,taux_tva)
  VALUES(1268002,1268001,'Second article fictif qualification',5,0,20);
INSERT INTO public.affaire(id,reference) VALUES(1268002,'QUAL1268-AFFAIRE-2');
INSERT INTO public.commande_ligne_affaire_allocation(id,commande_id,commande_ligne_id,livraison_affaire_id,qty_ordered)
  VALUES(1268002,1268001,1268002,1268002,10);
SET LOCAL ROLE cerp_app;
INSERT INTO public.proforma_client(id,reference,client_id,currency,preview_hash,preview_payload,created_by,correlation_id)
  VALUES('12680000-0000-4000-8000-000000000001','PF-QUAL1268',:'customer_id','EUR',repeat('a',64),'{}',7,'12680000-0000-4000-8000-000000000099');
INSERT INTO public.delivery_affair_billing_shares(id,allocation_id,billed_client_id,quantity,created_by,correlation_id)
  VALUES('12680000-0000-4000-8000-000000000002',1268001,:'billed_a_id',30,7,'12680000-0000-4000-8000-000000000099'),
        ('12680000-0000-4000-8000-000000000003',1268001,:'billed_b_id',70,7,'12680000-0000-4000-8000-000000000099');
INSERT INTO public.proforma_affair_lines(id,proforma_id,allocation_id,quantity,source_revision,source_snapshot)
  VALUES('12680000-0000-4000-8000-000000000004','12680000-0000-4000-8000-000000000001',1268001,100,repeat('b',64),'{}');
INSERT INTO public.proforma_billing_parts(id,proforma_line_id,billing_share_id,billed_client_id,quantity,unit_price_ex_tax,discount_percent,global_discount_percent,tax_rate_percent,total_ex_tax,tax_amount,total_incl_tax,billed_client_snapshot)
  VALUES('12680000-0000-4000-8000-000000000005','12680000-0000-4000-8000-000000000004','12680000-0000-4000-8000-000000000002',:'billed_a_id',30,10,0,0,20,300,60,360,'{}'),
        ('12680000-0000-4000-8000-000000000006','12680000-0000-4000-8000-000000000004','12680000-0000-4000-8000-000000000003',:'billed_b_id',70,10,0,0,20,700,140,840,'{}');
INSERT INTO public.delivery_affair_prepayment_terms(allocation_id,requirement,proforma_line_id,decision_reason,updated_by,correlation_id)
  VALUES(1268001,'PROFORMA','12680000-0000-4000-8000-000000000004','Qualification modèle isolé',7,'12680000-0000-4000-8000-000000000099');
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
  BEGIN
    INSERT INTO public.proforma_affair_lines(id,proforma_id,allocation_id,quantity,source_revision,source_snapshot)
      VALUES('12680000-0000-4000-8000-000000000010','12680000-0000-4000-8000-000000000001',1268001,101,repeat('b',64),'{}');
    RAISE EXCEPTION 'qualification failed: excess affair quantity accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.proforma_billing_parts SET quantity=31 WHERE id='12680000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'qualification failed: billed part differs from share';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.delivery_affair_billing_shares SET quantity=29,row_version=2 WHERE id='12680000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'qualification failed: unbalanced billing distribution accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
UPDATE public.proforma_client SET status='ISSUED',row_version=2,issued_snapshot='{"synthetic_isolated_model_fixture":true}',issued_at=now(),issued_by=7
  WHERE id='12680000-0000-4000-8000-000000000001';

DO $$ BEGIN
  BEGIN
    UPDATE public.proforma_client SET preview_payload='{"tampered":true}',row_version=3 WHERE reference='PF-QUAL1268';
    RAISE EXCEPTION 'qualification failed: issued snapshot update accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    UPDATE public.proforma_billing_parts SET total_ex_tax=1,tax_amount=0,total_incl_tax=1 WHERE id='12680000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'qualification failed: issued billed part update accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM public.proforma_client WHERE reference='PF-QUAL1268';
    RAISE EXCEPTION 'qualification failed: history deletion accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.delivery_affair_billing_shares SET quantity=31,row_version=2 WHERE id='12680000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'qualification failed: issued share update accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
  BEGIN
    DELETE FROM public.proforma_billing_parts WHERE id='12680000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'qualification failed: issued billed part deletion accepted';
  EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $$;
SELECT 'PROFORMA1268_MODEL_BEHAVIOR_PASS' AS marker,
  (SELECT sum(quantity) FROM public.proforma_billing_parts) AS billed_quantity,
  (SELECT sum(total_incl_tax) FROM public.proforma_billing_parts) AS billed_total_ttc;
-- An unpaid cancellation retains the issued history and permits a new,
-- balanced distribution version without rewriting either issued billed part.
UPDATE public.proforma_client SET status='CANCELLED',row_version=3,cancelled_at=now(),cancelled_by=7,cancellation_reason='Qualification annulation sans encaissement'
  WHERE id='12680000-0000-4000-8000-000000000001';
SET CONSTRAINTS ALL DEFERRED;
UPDATE public.delivery_affair_billing_shares SET active=false,row_version=2 WHERE allocation_id=1268001;
INSERT INTO public.delivery_affair_billing_shares(allocation_id,billed_client_id,quantity,plan_version,created_by,correlation_id)
  VALUES(1268001,:'billed_a_id',25,2,7,'12680000-0000-4000-8000-000000000099'),
        (1268001,:'billed_b_id',75,2,7,'12680000-0000-4000-8000-000000000099');
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
  IF (SELECT sum(quantity) FROM public.delivery_affair_billing_shares WHERE active)<>100 OR
     (SELECT sum(quantity) FROM public.proforma_billing_parts)<>100 OR
     (SELECT count(*) FROM public.delivery_affair_billing_shares WHERE NOT active)<>2 THEN
    RAISE EXCEPTION 'qualification failed: cancelled history or new distribution lost';
  END IF;
END $$;
SELECT 'PROFORMA1268_CANCEL_AND_REDISTRIBUTE_PASS' AS marker;
ROLLBACK;
