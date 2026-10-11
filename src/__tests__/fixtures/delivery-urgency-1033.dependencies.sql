-- Minimal prerequisite model for isolated PostgreSQL constraint tests.
-- The real migration and all runtime queries are compiled against the actual ERP schema separately.
CREATE SCHEMA urgency_1033_fixture;
CREATE TABLE urgency_1033_fixture.users(id integer PRIMARY KEY);
CREATE TABLE urgency_1033_fixture.commande_client(id bigint PRIMARY KEY,client_id text NOT NULL);
CREATE TABLE urgency_1033_fixture.commande_ligne(id bigint PRIMARY KEY,commande_id bigint,article_id uuid,piece_technique_version_id uuid);
CREATE TABLE urgency_1033_fixture.commande_ligne_affaire_allocation(
  id bigint PRIMARY KEY,commande_id bigint,commande_ligne_id bigint,livraison_affaire_id bigint);
CREATE TABLE urgency_1033_fixture.ordres_fabrication(id bigint PRIMARY KEY,commande_id bigint,commande_ligne_id bigint,affaire_id bigint,
  article_id uuid,client_id text,statut text,quantite_lancee numeric,piece_technique_version_id uuid,technical_preparation jsonb);
CREATE TABLE urgency_1033_fixture.stock_reservations(id uuid PRIMARY KEY,commande_ligne_affaire_allocation_id bigint,
  location_id uuid,status text,qty_reserved numeric,qty_consumed numeric,qty_prepared numeric);
CREATE TABLE urgency_1033_fixture.stock_lane_locations(location_id uuid PRIMARY KEY,lane text);
CREATE FUNCTION urgency_1033_fixture.fn_protect_stock_immutable_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
INSERT INTO urgency_1033_fixture.users VALUES(1);
INSERT INTO urgency_1033_fixture.commande_client VALUES(1,'client1'),(2,'client1'),(3,'other-client');
INSERT INTO urgency_1033_fixture.commande_ligne VALUES
  (1,1,'aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001'),
  (2,2,'aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001'),
  (3,3,'aaaaaaaa-0000-4000-8000-000000000001','bbbbbbbb-0000-4000-8000-000000000001');
INSERT INTO urgency_1033_fixture.commande_ligne_affaire_allocation VALUES(1,1,1,10),(2,2,2,20),(3,3,3,30);
INSERT INTO urgency_1033_fixture.stock_lane_locations VALUES('cccccccc-0000-4000-8000-000000000001','DELIVERY'),
  ('cccccccc-0000-4000-8000-000000000002','ASSEMBLY');
INSERT INTO urgency_1033_fixture.stock_reservations VALUES
  ('dddddddd-0000-4000-8000-000000000001',2,'cccccccc-0000-4000-8000-000000000001','ACTIVE',4,0,0),
  ('dddddddd-0000-4000-8000-000000000002',2,'cccccccc-0000-4000-8000-000000000002','ACTIVE',4,0,0);
INSERT INTO urgency_1033_fixture.ordres_fabrication VALUES
  (101,2,2,20,'aaaaaaaa-0000-4000-8000-000000000001','client1','BROUILLON',2,NULL,
    '{"selected_version_id":"bbbbbbbb-0000-4000-8000-000000000001"}'),
  (102,2,2,20,'aaaaaaaa-0000-4000-8000-000000000001','client1','BROUILLON',2,NULL,
    '{"selected_version_id":"bbbbbbbb-0000-4000-8000-000000000001"}');
GRANT USAGE ON SCHEMA urgency_1033_fixture TO cerp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA urgency_1033_fixture TO cerp_app;
-- The source identity trigger acquires a row lock as the application does.
GRANT UPDATE ON urgency_1033_fixture.stock_reservations TO cerp_app;
