BEGIN READ ONLY;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['delivery_urgency_restitutions','delivery_urgency_restitution_lines'] LOOP
  IF to_regclass('public.'||relation) IS NULL OR NOT has_table_privilege('cerp_app','public.'||relation,'SELECT')
   OR NOT has_table_privilege('cerp_app','public.'||relation,'INSERT')
   OR has_table_privilege('cerp_app','public.'||relation,'UPDATE,DELETE,TRUNCATE') THEN
   RAISE EXCEPTION 'Restitution evidence or privileges invalid: %',relation;
  END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
   JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace WHERE namespace.nspname='public' AND NOT tgisinternal AND tgenabled='O'
   AND tgname IN('urgency_restitution_immutable','urgency_restitution_lines_immutable','urgency_restitution_identity',
    'urgency_restitution_line_identity','urgency_restitution_balance','urgency_restitution_lines_balance'))<>6
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.delivery_urgency_requests'::regclass
    AND conname='delivery_urgency_restitution_owner' AND convalidated) THEN
  RAISE EXCEPTION 'Restitution identity and balance guards missing';
 END IF;
 IF EXISTS(SELECT 1 FROM public.delivery_urgency_restitutions restore
   JOIN public.delivery_urgency_requests request ON request.id=restore.request_id
   JOIN public.commande_ligne_affaire_allocation allocation ON allocation.id=request.beneficiary_allocation_id
   JOIN public.delivery_urgency_order_charges charge ON charge.id=restore.charge_id
   WHERE request.status<>'CANCELLED' OR request.restitution_id IS DISTINCT FROM restore.id
    OR request.withdrawn_id IS DISTINCT FROM restore.withdrawal_id OR NOT request.cancellation_retains_production
    OR charge.commande_id<>allocation.commande_id OR request.quantity IS DISTINCT FROM
      (SELECT sum(donor_quantity+free_quantity) FROM public.delivery_urgency_restitution_lines WHERE restitution_id=restore.id)) THEN
  RAISE EXCEPTION 'Restitution is incomplete or lost its original commitments';
 END IF;
END $$;
ROLLBACK;
