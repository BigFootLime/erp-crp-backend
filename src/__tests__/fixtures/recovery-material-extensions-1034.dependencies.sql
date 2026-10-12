-- Isolated synthetic prerequisites; every use must run inside BEGIN/ROLLBACK.
CREATE SCHEMA recovery_material_1034_fixture;
SET LOCAL search_path=recovery_material_1034_fixture,public;
CREATE TABLE users(id integer PRIMARY KEY);
CREATE TABLE delivery_urgency_requests(id uuid PRIMARY KEY,status text);
CREATE TABLE delivery_urgency_recoveries(id uuid PRIMARY KEY,request_id uuid,recovery_of_id bigint,quantity numeric);
CREATE TABLE production_consolidations(id uuid PRIMARY KEY,producer_of_id bigint,state text);
CREATE TABLE production_consolidation_allocations(consolidation_id uuid,source_of_id bigint,quantity numeric,state text);
CREATE TABLE lots(id uuid PRIMARY KEY);
CREATE TABLE stock_levels(id uuid PRIMARY KEY,article_id uuid,location_id uuid,qty_reserved numeric);
CREATE TABLE stock_batches(id uuid PRIMARY KEY,qty_reserved numeric);
CREATE TABLE stock_reservations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),article_id uuid,location_id uuid,lot_id uuid,
  stock_batch_id uuid,qty_reserved numeric(12,3),qty_consumed numeric(12,3) DEFAULT 0,qty_prepared numeric(12,3) DEFAULT 0,
  of_id bigint,source_type text,source_id text,material_need_id uuid,status text,expires_at timestamptz,
  released_at timestamptz,released_by integer,updated_at timestamptz,updated_by integer,created_by integer,reason text,correlation_id uuid);
CREATE UNIQUE INDEX active_need_lot ON stock_reservations(material_need_id,article_id,location_id,lot_id) WHERE status='ACTIVE';
CREATE TABLE production_consolidation_material_holds(consolidation_id uuid,producer_reservation_id uuid,producer_need_id uuid,
  transferred_qty numeric(12,3),surplus_qty numeric(12,3),PRIMARY KEY(consolidation_id,producer_reservation_id));
CREATE TABLE production_consolidation_material_transfers(consolidation_id uuid,reservation_id uuid,source_of_id bigint,
  source_need_id uuid,producer_need_id uuid,producer_reservation_id uuid,source_reserved_qty numeric(12,3),PRIMARY KEY(consolidation_id,reservation_id));
CREATE FUNCTION prevent_material_debit_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable material history' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_holds BEFORE UPDATE OR DELETE ON production_consolidation_material_holds
  FOR EACH ROW EXECUTE FUNCTION prevent_material_debit_rewrite();
CREATE TRIGGER immutable_transfers BEFORE UPDATE OR DELETE ON production_consolidation_material_transfers
  FOR EACH ROW EXECUTE FUNCTION prevent_material_debit_rewrite();
CREATE FUNCTION expect_rejected(command text,expected_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text;
BEGIN
  BEGIN EXECUTE command; SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE; END;
  SET CONSTRAINTS ALL DEFERRED;
  IF actual IS DISTINCT FROM expected_state THEN RAISE EXCEPTION 'Expected rejection %, got % for %',expected_state,actual,command; END IF;
END $$;
GRANT USAGE ON SCHEMA recovery_material_1034_fixture TO cerp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA recovery_material_1034_fixture TO cerp_app;
