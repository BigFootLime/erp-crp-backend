\set ON_ERROR_STOP on
DO $check$
DECLARE before public.precision_view_before%ROWTYPE;
BEGIN
  IF current_database()<>'precision1062' THEN RAISE EXCEPTION 'Use only the isolated precision1062 database'; END IF;
  SELECT * INTO STRICT before FROM public.precision_view_before;
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.v_production_active_executions'::regclass
      AND pg_get_viewdef(c.oid,true)=before.definition AND pg_get_userbyid(c.relowner)=before.owner
      AND c.reloptions IS NOT DISTINCT FROM before.options AND obj_description(c.oid,'pg_class')=before.comment) THEN
    RAISE EXCEPTION 'View metadata changed';
  END IF;
  IF NOT has_table_privilege('cerp_app','public.v_production_active_executions','SELECT WITH GRANT OPTION')
      OR NOT has_table_privilege('precision_observer','public.v_production_active_executions','SELECT')
      OR has_table_privilege('precision_default_extra','public.v_production_active_executions','SELECT') THEN
    RAISE EXCEPTION 'View permissions changed';
  END IF;
  IF col_description('public.v_production_active_executions'::regclass,
      (SELECT attnum FROM pg_attribute WHERE attrelid='public.v_production_active_executions'::regclass AND attname='temps_total_planned'))<>'Isolated duration comment' THEN
    RAISE EXCEPTION 'Column comment changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.pieces_techniques_achats WHERE id=1 AND prix=0.03 AND pu_achat=0.03 AND total_achat_ht=2.76)
      OR NOT EXISTS(SELECT 1 FROM public.pieces_techniques_operations WHERE id=1 AND temps_total=0.383)
      OR NOT EXISTS(SELECT 1 FROM public.of_operations WHERE id=1 AND tp=0.333 AND tf_unit=0.05 AND temps_total_planned=0.383 AND temps_total_real=0.017) THEN
    RAISE EXCEPTION 'Historical values changed';
  END IF;
END;
$check$;
INSERT INTO public.pieces_techniques_achats VALUES(2,0.025,0.025,round(110.5*0.025,2)),(3,0.000001,0.000001,0.01)
  ON CONFLICT(id) DO NOTHING;
INSERT INTO public.pieces_techniques_operations VALUES(2,0.3833),(3,0.0167),(4,0.0083) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.of_operations VALUES(2,0.333333,0.016667,0.533337,0.000278) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.pieces_techniques_achats WHERE id=2 AND prix=0.025 AND pu_achat=0.025 AND total_achat_ht=2.76)
      OR NOT EXISTS(SELECT 1 FROM public.pieces_techniques_achats WHERE id=3 AND prix=0.000001)
      OR NOT EXISTS(SELECT 1 FROM public.pieces_techniques_operations WHERE id=2 AND round(temps_total*60,2)=23.00)
      OR NOT EXISTS(SELECT 1 FROM public.pieces_techniques_operations WHERE id=3 AND round(temps_total*60,2)=1.00)
      OR NOT EXISTS(SELECT 1 FROM public.pieces_techniques_operations WHERE id=4 AND round(temps_total*60,2)=0.50)
      OR NOT EXISTS(SELECT 1 FROM public.of_operations WHERE id=2 AND tp=0.333333 AND tf_unit=0.016667 AND temps_total_planned=0.533337 AND temps_total_real=0.000278) THEN
    RAISE EXCEPTION 'Fractional values lost precision';
  END IF;
END $$;
SET ROLE cerp_app;
SELECT pointage_id,temps_total_planned,temps_total_real FROM public.v_production_active_executions;
RESET ROLE;
SELECT 'Precision, view access and history checks PASS';
