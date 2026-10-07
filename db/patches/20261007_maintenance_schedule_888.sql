-- Calendar definitions do not populate a schedule or invent workshop dates.
CREATE TABLE public.production_maintenance_schedules (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 kind text NOT NULL CHECK(kind IN ('LEVEL_1_WEEKLY','LEVEL_2_ANNUAL')),
 version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL DEFAULT true,
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.production_maintenance_schedule_revisions (
 schedule_id uuid NOT NULL REFERENCES public.production_maintenance_schedules(id) ON DELETE RESTRICT,
 version integer NOT NULL CHECK(version>0), enabled boolean NOT NULL,
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 1000),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(schedule_id,version)
);
ALTER TABLE public.production_maintenance_schedules ADD CONSTRAINT maintenance_schedule_current_revision_888
 FOREIGN KEY(id,version) REFERENCES public.production_maintenance_schedule_revisions(schedule_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.production_maintenance_schedule_occurrences (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 schedule_id uuid NOT NULL, schedule_version integer NOT NULL,
 unavailability_id uuid NOT NULL UNIQUE REFERENCES public.production_machine_unavailability(id) ON DELETE RESTRICT,
 machine_id uuid NOT NULL REFERENCES public.machines(id) ON DELETE RESTRICT,
 start_ts timestamptz NOT NULL, end_ts timestamptz NOT NULL CHECK(end_ts>start_ts),
 provider_id uuid REFERENCES public.fournisseurs(id) ON DELETE RESTRICT,
 responsible_user_id integer REFERENCES public.users(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 created_by integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(schedule_id,schedule_version) REFERENCES public.production_maintenance_schedule_revisions(schedule_id,version) ON DELETE RESTRICT
);
CREATE INDEX maintenance_schedule_occurrences_dates_888 ON public.production_maintenance_schedule_occurrences(machine_id,start_ts,end_ts);
CREATE INDEX maintenance_schedule_occurrences_rule_888 ON public.production_maintenance_schedule_occurrences(schedule_id,schedule_version);
CREATE TRIGGER maintenance_schedule_revisions_immutable_888 BEFORE UPDATE OR DELETE ON public.production_maintenance_schedule_revisions FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE TRIGGER maintenance_schedule_occurrences_immutable_888 BEFORE UPDATE OR DELETE ON public.production_maintenance_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION public.prevent_material_debit_rewrite();
CREATE FUNCTION public.guard_maintenance_schedule_rewrite_888() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
 OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
 OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'MAINTENANCE_SCHEDULE_VERSION_REQUIRED' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER maintenance_schedule_guard_888 BEFORE UPDATE OR DELETE ON public.production_maintenance_schedules FOR EACH ROW EXECUTE FUNCTION public.guard_maintenance_schedule_rewrite_888();
CREATE TRIGGER planning_invalidate AFTER INSERT OR UPDATE ON public.production_maintenance_schedules FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate();
GRANT SELECT,INSERT ON public.production_maintenance_schedules,public.production_maintenance_schedule_revisions,public.production_maintenance_schedule_occurrences TO cerp_app;
GRANT UPDATE(version,enabled,updated_by,updated_at) ON public.production_maintenance_schedules TO cerp_app;
REVOKE DELETE,TRUNCATE ON public.production_maintenance_schedules FROM cerp_app;
REVOKE UPDATE,DELETE,TRUNCATE ON public.production_maintenance_schedule_revisions,public.production_maintenance_schedule_occurrences FROM cerp_app;
