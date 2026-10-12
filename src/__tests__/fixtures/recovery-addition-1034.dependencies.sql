CREATE SCHEMA recovery_addition_1034_fixture;
GRANT USAGE ON SCHEMA recovery_addition_1034_fixture TO cerp_app;
CREATE TABLE recovery_addition_1034_fixture.users(id integer PRIMARY KEY);
CREATE TABLE recovery_addition_1034_fixture.ordres_fabrication(
 id bigint PRIMARY KEY,statut text,quantite_lancee numeric(18,3),client_id text,article_id uuid,
 piece_technique_id uuid,piece_technique_version_id uuid,technical_snapshot_sha256 text,technical_snapshot jsonb);
CREATE TABLE recovery_addition_1034_fixture.delivery_urgency_requests(id uuid PRIMARY KEY,status text);
CREATE TABLE recovery_addition_1034_fixture.delivery_urgency_recoveries(id uuid PRIMARY KEY,request_id uuid,recovery_of_id bigint,
 quantity numeric(18,3),protected_due_date date,initial_ar_due_date date);
CREATE TABLE recovery_addition_1034_fixture.production_consolidations(id uuid PRIMARY KEY,producer_of_id bigint,state text);
CREATE TABLE recovery_addition_1034_fixture.production_consolidation_allocations(id uuid PRIMARY KEY,consolidation_id uuid,source_of_id bigint,quantity numeric(18,3),state text);
CREATE TABLE recovery_addition_1034_fixture.of_dossier_validations(id uuid PRIMARY KEY,of_id bigint,invalidated_at timestamptz,evidence jsonb);
CREATE TABLE recovery_addition_1034_fixture.of_revisions(id uuid PRIMARY KEY,statut text,of_id bigint);
CREATE TABLE recovery_addition_1034_fixture.of_operations(id uuid PRIMARY KEY,of_id bigint,phase integer,revision_id uuid,status text,started_at timestamptz,ended_at timestamptz);
CREATE TABLE recovery_addition_1034_fixture.planning_events(id uuid PRIMARY KEY,of_id bigint,of_operation_id uuid,archived_at timestamptz,status text,start_ts timestamptz,end_ts timestamptz,machine_id uuid,poste_id uuid);
CREATE TABLE recovery_addition_1034_fixture.planning_tasks(id text PRIMARY KEY,operation_id uuid,committed_start timestamptz,committed_end timestamptz);
CREATE TABLE recovery_addition_1034_fixture.production_purchase_preparations(id uuid PRIMARY KEY,of_id bigint,kind text,status text,source_ref text,
 supplier_id uuid,technical_hash text,technical_version_id uuid,of_revision_id uuid,snapshot jsonb);
CREATE FUNCTION recovery_addition_1034_fixture.prevent_material_debit_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable evidence' USING ERRCODE='55000'; END $$;
CREATE FUNCTION recovery_addition_1034_fixture.expect_rejected(command text, expected text DEFAULT '23514') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  EXECUTE command; SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Expected rejection: %',command;
 EXCEPTION WHEN OTHERS THEN IF SQLSTATE<>expected THEN RAISE; END IF; END;
 SET CONSTRAINTS ALL DEFERRED;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA recovery_addition_1034_fixture TO cerp_app;
