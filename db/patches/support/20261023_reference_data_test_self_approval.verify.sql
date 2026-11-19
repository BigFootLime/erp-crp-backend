DO $verify$
DECLARE definition text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO STRICT definition FROM pg_constraint
  WHERE conrelid='public.reference_data_change_sets'::regclass
    AND conname='reference_data_change_actor_separation_ck' AND convalidated;
  IF current_database()='cerp_test' AND position('current_database()' IN definition)=0 THEN
    RAISE EXCEPTION 'Test self-approval constraint is missing';
  END IF;
  IF current_database()<>'cerp_test' AND position('current_database()' IN definition)>0 THEN
    RAISE EXCEPTION 'Unexpected production constraint change';
  END IF;
END
$verify$;
