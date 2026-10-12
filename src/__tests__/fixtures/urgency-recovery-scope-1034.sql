-- Synthetic relations; run in a transaction rolled back by the verification runner.
CREATE SCHEMA urgency_scope_1034_fixture;
CREATE TABLE urgency_scope_1034_fixture.ordres_fabrication(id bigint PRIMARY KEY,root_of_id bigint,client_id text);
CREATE TABLE urgency_scope_1034_fixture.production_consolidations(id bigint PRIMARY KEY,producer_of_id bigint,state text);
CREATE TABLE urgency_scope_1034_fixture.production_consolidation_allocations(id bigint PRIMARY KEY,consolidation_id bigint,source_of_id bigint,state text);
CREATE TABLE urgency_scope_1034_fixture.delivery_urgency_requests(id uuid PRIMARY KEY,status text);
CREATE TABLE urgency_scope_1034_fixture.delivery_urgency_recoveries(id uuid PRIMARY KEY,request_id uuid,recovery_of_id bigint);
INSERT INTO urgency_scope_1034_fixture.ordres_fabrication VALUES
 (1,1,'A'),(2,1,'A'),(3,3,'A'),(4,4,'B'),(10,10,'A'),(11,10,'A'),
 (20,20,'A'),(21,20,'A'),(30,30,'A'),(40,40,'A'),(50,NULL,'B'),(51,50,'B'),
 (60,60,'A'),(61,60,'A'),(70,71,'A'),(71,70,'A'),(80,80,'A'),(90,90,'A'),(100,100,'A');
INSERT INTO urgency_scope_1034_fixture.delivery_urgency_requests VALUES
 ('00000000-0000-4000-8000-000000000001','WAITING_PLANNER'),
 ('00000000-0000-4000-8000-000000000002','APPROVED'),
 ('00000000-0000-4000-8000-000000000003','WITHDRAWN'),
 ('00000000-0000-4000-8000-000000000004','CANCELLED');
INSERT INTO urgency_scope_1034_fixture.delivery_urgency_recoveries VALUES
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001',1),
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000001',50),
 ('00000000-0000-4000-8000-000000000103','00000000-0000-4000-8000-000000000002',80),
 ('00000000-0000-4000-8000-000000000104','00000000-0000-4000-8000-000000000003',90),
 ('00000000-0000-4000-8000-000000000105','00000000-0000-4000-8000-000000000004',100);
INSERT INTO urgency_scope_1034_fixture.production_consolidations VALUES
 (1,10,'ACTIVE'),(2,20,'ACTIVE'),(3,30,'DISSOLVED'),(4,40,'ACTIVE'),(6,60,'ACTIVE'),(7,70,'ACTIVE');
INSERT INTO urgency_scope_1034_fixture.production_consolidation_allocations VALUES
 (1,1,1,'ACTIVE'),(2,1,3,'ACTIVE'),(3,1,2,'ACTIVE'),(4,2,10,'ACTIVE'),(5,2,4,'ACTIVE'),
 (6,3,1,'ACTIVE'),(7,4,1,'CANCELLED'),(8,6,50,'ACTIVE'),(9,7,1,'ACTIVE'),
 (10,1,80,'ACTIVE'),(11,1,90,'ACTIVE'),(12,1,100,'ACTIVE');
GRANT USAGE ON SCHEMA urgency_scope_1034_fixture TO cerp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA urgency_scope_1034_fixture TO cerp_app;
