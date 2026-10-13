-- Synthetic data only. Caller opens a transaction, creates functions from the
-- actual repository SELECTs, checks them as cerp_app, and rolls everything back.
CREATE SCHEMA recovery_grouping_fixture;
SET LOCAL search_path=recovery_grouping_fixture;
CREATE TABLE app_feature_flags(key text,enabled boolean);
CREATE TABLE delivery_urgency_requests(id uuid,status text,version int);
CREATE TABLE delivery_urgency_recoveries(id uuid,request_id uuid,recovery_of_id bigint,quantity numeric,
  donor_allocation_id bigint,donor_snapshot jsonb,protected_due_date date,initial_ar_due_date date);
CREATE TABLE production_consolidations(id uuid,producer_of_id bigint,state text);
CREATE TABLE ordres_fabrication(id bigint,numero text,client_id text,article_id uuid,piece_technique_id uuid,
  piece_technique_version_id uuid,technical_snapshot_sha256 text,quantite_lancee numeric,statut text,
  commande_id bigint,commande_ligne_id bigint,affaire_id bigint,root_of_id bigint,updated_at timestamptz);
CREATE TABLE production_consolidation_allocations(consolidation_id uuid,source_of_id bigint,quantity numeric,received_quantity numeric,due_date date,state text);
CREATE TABLE commande_client(id bigint,client_id text,order_type text);
CREATE TABLE commande_ligne(id bigint,commande_id bigint,article_id uuid,piece_technique_version_id uuid);
CREATE TABLE commande_ligne_affaire_allocation(id bigint,commande_id bigint,commande_ligne_id bigint,livraison_affaire_id bigint);
CREATE TABLE delivery_promise_roots(id bigint,allocation_id bigint,initial_due_date date);
CREATE TABLE delivery_promise_parts(id bigint,root_id bigint,retired_at timestamptz,due_date date,quantity numeric);
CREATE TABLE delivery_promise_shipments(part_id bigint,quantity numeric);
CREATE TABLE commande_historique(id bigint,commande_id bigint,nouveau_statut text,date_action timestamptz);
CREATE TABLE affaire(id bigint,statut text);
CREATE TABLE piece_technique_versions(id uuid,piece_technique_id uuid);
INSERT INTO app_feature_flags VALUES('PRODUCTION_CONSOLIDATION',true);
INSERT INTO delivery_urgency_requests VALUES('00000000-0000-0000-0000-000000000001','WAITING_PLANNER',3);
INSERT INTO delivery_urgency_recoveries VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001',20,10,20,'{}','2026-10-20','2026-10-16');
INSERT INTO production_consolidations VALUES('00000000-0000-0000-0000-000000000003',10,'ACTIVE');
INSERT INTO ordres_fabrication VALUES
 (10,'PRODUCER','A',null,null,null,'hash',100,'EN_COURS',1,11,11,10,now()),
 (11,'SOURCE','A',null,null,null,'hash',100,'BROUILLON',1,11,11,11,now()),
 (12,'INACTIVE','B',null,null,null,'hash',50,'BROUILLON',1,12,12,12,now()),
 (20,'RECOVERY','A','00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000031',
  '00000000-0000-0000-0000-000000000032','hash',10,'BROUILLON',2,20,20,20,now());
INSERT INTO production_consolidation_allocations VALUES
 ('00000000-0000-0000-0000-000000000003',11,100,20,'2026-10-22','ACTIVE'),
 ('00000000-0000-0000-0000-000000000003',12,50,0,'2026-10-13','CANCELLED');
INSERT INTO commande_client VALUES(1,'A','FERME'),(2,'A','FERME'),(3,'A','FERME');
INSERT INTO commande_ligne VALUES(11,1,null,null),
 (20,2,'00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000032'),
 (21,3,'00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000032');
INSERT INTO commande_ligne_affaire_allocation VALUES(11,1,11,11),(20,2,20,20),(21,3,21,21);
INSERT INTO affaire VALUES(11,'OUVERTE'),(20,'OUVERTE'),(21,'OUVERTE');
INSERT INTO piece_technique_versions VALUES('00000000-0000-0000-0000-000000000032','00000000-0000-0000-0000-000000000031');
INSERT INTO delivery_promise_roots VALUES(11,11,'2026-10-15'),(20,20,'2026-10-16'),(21,21,'2026-10-17');
INSERT INTO delivery_promise_parts VALUES
 (110,11,null,'2026-10-20',100),(111,11,now(),'2026-10-12',100),(112,11,null,'2026-10-14',20),
 (200,20,null,'2026-10-21',10),(210,21,null,'2026-10-22',10);
INSERT INTO delivery_promise_shipments VALUES(112,20);
INSERT INTO commande_historique VALUES(1,3,'ANNULE',now());
GRANT USAGE ON SCHEMA recovery_grouping_fixture TO cerp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA recovery_grouping_fixture TO cerp_app;
