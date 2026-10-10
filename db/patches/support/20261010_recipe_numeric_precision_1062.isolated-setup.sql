\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database()<>'precision1062' THEN RAISE EXCEPTION 'Use only the isolated precision1062 database'; END IF;
END $$;
CREATE ROLE cerp_app;
CREATE ROLE precision_observer;
CREATE ROLE precision_default_extra;
CREATE TABLE public.pieces_techniques_achats(id int PRIMARY KEY,prix numeric(12,2),pu_achat numeric(12,2),total_achat_ht numeric(12,2));
CREATE TABLE public.pieces_techniques_operations(id int PRIMARY KEY,temps_total numeric(12,3));
CREATE TABLE public.of_operations(id int PRIMARY KEY,tp numeric(12,3),tf_unit numeric(12,3),temps_total_planned numeric(12,3),temps_total_real numeric(12,3));
INSERT INTO public.pieces_techniques_achats VALUES(1,0.03,0.03,2.76);
INSERT INTO public.pieces_techniques_operations VALUES(1,0.383);
INSERT INTO public.of_operations VALUES(1,0.333,0.05,0.383,0.017);
CREATE VIEW public.v_production_active_executions WITH (security_barrier=true) AS
  SELECT id AS pointage_id,temps_total_planned,temps_total_real FROM public.of_operations;
COMMENT ON VIEW public.v_production_active_executions IS 'Isolated execution view comment';
COMMENT ON COLUMN public.v_production_active_executions.temps_total_planned IS 'Isolated duration comment';
GRANT SELECT ON public.v_production_active_executions TO cerp_app WITH GRANT OPTION;
GRANT SELECT ON public.v_production_active_executions TO precision_observer;
CREATE TABLE public.precision_view_before AS SELECT
  pg_get_viewdef(c.oid,true) AS definition,pg_get_userbyid(c.relowner) AS owner,c.reloptions AS options,
  obj_description(c.oid,'pg_class') AS comment FROM pg_class c
  WHERE c.oid='public.v_production_active_executions'::regclass;
-- Recreation must not add this permission through the owner's default privileges.
ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO precision_default_extra;
CREATE VIEW public.precision_dependent AS SELECT * FROM public.v_production_active_executions;
