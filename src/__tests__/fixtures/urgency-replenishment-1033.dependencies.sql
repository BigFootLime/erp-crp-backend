-- Synthetic prerequisite relations. The runner always rolls this schema back.
CREATE SCHEMA urgency_replenishment_1033_fixture;
CREATE TABLE urgency_replenishment_1033_fixture.users(id integer PRIMARY KEY);
CREATE TABLE urgency_replenishment_1033_fixture.delivery_urgency_requests(id uuid PRIMARY KEY,status text);
CREATE TABLE urgency_replenishment_1033_fixture.delivery_urgency_recoveries(id uuid PRIMARY KEY,request_id uuid,
  donor_allocation_id bigint,recovery_of_id bigint,quantity numeric);
CREATE TABLE urgency_replenishment_1033_fixture.lots(id uuid PRIMARY KEY);
CREATE TABLE urgency_replenishment_1033_fixture.stock_reservations(id uuid PRIMARY KEY,
  commande_ligne_affaire_allocation_id bigint,lot_id uuid,status text,qty_reserved numeric,qty_consumed numeric);
CREATE TABLE urgency_replenishment_1033_fixture.stock_movements(id uuid PRIMARY KEY,status text);
CREATE TABLE urgency_replenishment_1033_fixture.of_receipts(id uuid PRIMARY KEY,of_id bigint,
  stock_movement_id uuid,lot_id uuid,qty_ok numeric);
CREATE TABLE urgency_replenishment_1033_fixture.production_consolidations(id uuid PRIMARY KEY,producer_of_id bigint);
CREATE TABLE urgency_replenishment_1033_fixture.production_consolidation_allocations(id uuid PRIMARY KEY,consolidation_id uuid,source_of_id bigint);
CREATE TABLE urgency_replenishment_1033_fixture.production_consolidation_receipt_allocations(allocation_id uuid,movement_id uuid,lot_id uuid,quantity numeric);
CREATE TABLE urgency_replenishment_1033_fixture.production_receipt_lane_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),receipt_id uuid,distribution jsonb);
CREATE FUNCTION urgency_replenishment_1033_fixture.fn_protect_stock_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
CREATE FUNCTION urgency_replenishment_1033_fixture.expect_rejected(command text,expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text;
BEGIN
  BEGIN EXECUTE command; SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE; END;
  SET CONSTRAINTS ALL DEFERRED;
  IF actual IS DISTINCT FROM expected_state THEN RAISE EXCEPTION 'Expected rejection %, got % for %',expected_state,actual,command; END IF;
END $$;
GRANT USAGE ON SCHEMA urgency_replenishment_1033_fixture TO cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA urgency_replenishment_1033_fixture TO cerp_app;
