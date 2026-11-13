DO $verify$
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND numeric_precision=16 AND numeric_scale=6 AND (
        (table_name='pieces_techniques_achats' AND column_name IN('prix','pu_achat')) OR
        (table_name='pieces_techniques_operations' AND column_name='temps_total') OR
        (table_name='of_operations' AND column_name IN('tp','tf_unit','temps_total_planned','temps_total_real'))))<>7 THEN
    RAISE EXCEPTION 'Recipe numeric precision is incomplete';
  END IF;
  IF (SELECT numeric_scale FROM information_schema.columns WHERE table_schema='public'
      AND table_name='pieces_techniques_achats' AND column_name='total_achat_ht')<>2 THEN
    RAISE EXCEPTION 'Monetary total precision must remain unchanged';
  END IF;
  IF to_regclass('public.v_production_active_executions') IS NULL
      OR NOT has_table_privilege('cerp_app','public.v_production_active_executions','SELECT') THEN
    RAISE EXCEPTION 'Active execution view access was not restored';
  END IF;
END;
$verify$;
SELECT pointage_id,temps_total_planned,temps_total_real FROM public.v_production_active_executions LIMIT 0;
