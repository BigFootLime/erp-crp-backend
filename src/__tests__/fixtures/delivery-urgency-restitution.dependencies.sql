-- Synthetic prerequisites; runtime SQL is separately compiled against the real ERP schema.
CREATE TABLE urgency_1033_fixture.delivery_urgency_order_charges(id uuid PRIMARY KEY,commande_id bigint);
CREATE TABLE urgency_1033_fixture.delivery_urgency_replenishments(id uuid PRIMARY KEY,recovery_id uuid,quantity numeric);
CREATE TABLE urgency_1033_fixture.stock_movements(id uuid PRIMARY KEY,status text,movement_type text,source_document_type text,source_document_id text);
CREATE TABLE urgency_1033_fixture.stock_movement_lines(id uuid PRIMARY KEY,movement_id uuid,article_id uuid,lot_id uuid,qty numeric,src_emplacement_id uuid,dst_emplacement_id uuid);
CREATE TABLE urgency_1033_fixture.emplacements(id uuid PRIMARY KEY,location_id uuid);
GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA urgency_1033_fixture TO cerp_app;
GRANT UPDATE(id) ON urgency_1033_fixture.delivery_urgency_recoveries TO cerp_app;
INSERT INTO urgency_1033_fixture.stock_lane_locations VALUES('cccccccc-0000-4000-8000-000000000003','FREE');
INSERT INTO urgency_1033_fixture.emplacements VALUES
 ('cccccccc-0000-4000-8000-000000000011','cccccccc-0000-4000-8000-000000000001'),
 ('cccccccc-0000-4000-8000-000000000013','cccccccc-0000-4000-8000-000000000003');
