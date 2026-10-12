-- Synthetic schema only, always executed inside a rolled-back transaction.
CREATE SCHEMA urgency_fee_1033_fixture;
CREATE TABLE urgency_fee_1033_fixture.users(id integer PRIMARY KEY);
CREATE TABLE urgency_fee_1033_fixture.clients(client_id text PRIMARY KEY);
CREATE TABLE urgency_fee_1033_fixture.commande_client(id bigint PRIMARY KEY,client_id text);
CREATE TABLE urgency_fee_1033_fixture.commande_ligne(id bigint PRIMARY KEY,commande_id bigint);
CREATE TABLE urgency_fee_1033_fixture.commande_ligne_affaire_allocation(id bigint PRIMARY KEY,commande_id bigint);
CREATE TABLE urgency_fee_1033_fixture.delivery_urgency_requests(id uuid PRIMARY KEY,beneficiary_allocation_id bigint,snapshot jsonb,status text DEFAULT 'APPROVED');
CREATE TABLE urgency_fee_1033_fixture.delivery_urgency_withdrawals(id uuid PRIMARY KEY,request_id uuid);
CREATE TABLE urgency_fee_1033_fixture.facture(id bigint PRIMARY KEY,client_id text,currency text,document_status text,statut text);
CREATE TABLE urgency_fee_1033_fixture.facture_ligne(id bigint PRIMARY KEY,facture_id bigint,quantite numeric,prix_unitaire_ht numeric,
  remise_ligne numeric,taux_tva numeric,total_ht numeric,total_ttc numeric,tax_amount numeric,snapshot_json jsonb);
CREATE TABLE urgency_fee_1033_fixture.bon_livraison(id uuid PRIMARY KEY,commande_id bigint);
CREATE TABLE urgency_fee_1033_fixture.bon_livraison_ligne(id uuid PRIMARY KEY,bon_livraison_id uuid,commande_ligne_id bigint);
CREATE TABLE urgency_fee_1033_fixture.facture_source_allocations(facture_id bigint,source_type text,source_line_id text);
CREATE FUNCTION urgency_fee_1033_fixture.fn_protect_stock_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
INSERT INTO urgency_fee_1033_fixture.users VALUES(1);
INSERT INTO urgency_fee_1033_fixture.clients VALUES('C1'),('C2');
INSERT INTO urgency_fee_1033_fixture.commande_client VALUES(1,'C1'),(2,'C1'),(3,'C2');
INSERT INTO urgency_fee_1033_fixture.commande_ligne VALUES(1,1),(2,2);
INSERT INTO urgency_fee_1033_fixture.commande_ligne_affaire_allocation VALUES(1,1),(2,1),(3,2);
INSERT INTO urgency_fee_1033_fixture.delivery_urgency_requests(id,beneficiary_allocation_id,snapshot) VALUES
  ('00000000-0000-4000-8000-000000000001',1,'{"preview":{"urgency_fee":{"amount_ht":"35.50","currency":"EUR","tax_rate_percent":"20.0000","settings_version":1}}}'),
  ('00000000-0000-4000-8000-000000000002',2,'{"preview":{"urgency_fee":{"amount_ht":"35.50","currency":"EUR","tax_rate_percent":"20.0000","settings_version":1}}}'),
  ('00000000-0000-4000-8000-000000000003',3,'{"preview":{"urgency_fee":{"amount_ht":"35.50","currency":"EUR","tax_rate_percent":"20.0000","settings_version":1}}}');
INSERT INTO urgency_fee_1033_fixture.facture VALUES(1,'C1','EUR','DRAFT','DRAFT'),(2,'C1','EUR','DRAFT','DRAFT'),
  (3,'C2','EUR','DRAFT','DRAFT'),(4,'C1','USD','DRAFT','DRAFT'),(5,'C1','EUR','ISSUED','ISSUED');
INSERT INTO urgency_fee_1033_fixture.bon_livraison VALUES('00000000-0000-4000-8000-000000000011',2);
-- Consolidated BL: header order 2, actual line order 1 must determine the charge.
INSERT INTO urgency_fee_1033_fixture.bon_livraison_ligne VALUES('00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000011',1);
INSERT INTO urgency_fee_1033_fixture.facture_source_allocations
  SELECT id,'DELIVERY_LINE','00000000-0000-4000-8000-000000000012' FROM urgency_fee_1033_fixture.facture WHERE id<>2;
GRANT USAGE ON SCHEMA urgency_fee_1033_fixture TO cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA urgency_fee_1033_fixture TO cerp_app;
CREATE FUNCTION urgency_fee_1033_fixture.expect_rejected(command text,expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text;
BEGIN
  BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE; END;
  IF actual IS DISTINCT FROM expected_state THEN RAISE EXCEPTION 'Expected rejection %, got %',expected_state,actual; END IF;
END $$;
