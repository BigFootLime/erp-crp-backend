-- Resource qualification and availability changes invalidate pending scheduling previews.
BEGIN;
DO $$ DECLARE t text; BEGIN
  IF to_regprocedure('public.planning_invalidate()') IS NULL THEN
    RAISE EXCEPTION 'Planning central must be installed before resource invalidation';
  END IF;
  FOREACH t IN ARRAY ARRAY['machines','postes','user_role_assignments','app_roles'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS planning_invalidate ON public.%I',t);
    EXECUTE format('CREATE TRIGGER planning_invalidate AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate()',t);
  END LOOP;
END $$;
-- Authentication/profile bookkeeping must not invalidate an otherwise valid preview.
DROP TRIGGER IF EXISTS planning_invalidate ON public.users;
DROP TRIGGER IF EXISTS planning_invalidate_membership ON public.users;
CREATE TRIGGER planning_invalidate AFTER INSERT OR DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.planning_invalidate();
CREATE TRIGGER planning_invalidate_membership AFTER UPDATE ON public.users
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.planning_invalidate();
COMMIT;
