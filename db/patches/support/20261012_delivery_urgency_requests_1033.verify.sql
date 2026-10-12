BEGIN READ ONLY;
DO $$ DECLARE relation text; BEGIN
  FOREACH relation IN ARRAY ARRAY['delivery_urgency_requests','delivery_urgency_recoveries','delivery_urgency_sources','delivery_urgency_approvals',
    'delivery_urgency_withdrawals','delivery_urgency_transfers'] LOOP
    IF to_regclass('public.'||relation) IS NULL OR NOT has_table_privilege('cerp_app','public.'||relation,'SELECT')
      OR NOT has_table_privilege('cerp_app','public.'||relation,'INSERT')
      OR has_table_privilege('cerp_app','public.'||relation,'DELETE') OR has_table_privilege('cerp_app','public.'||relation,'TRUNCATE') THEN
      RAISE EXCEPTION 'Urgency evidence table or grants invalid: %',relation;
    END IF;
  END LOOP;
  IF has_table_privilege('cerp_app','public.delivery_urgency_recoveries','UPDATE')
    OR has_table_privilege('cerp_app','public.delivery_urgency_sources','UPDATE')
    OR has_table_privilege('cerp_app','public.delivery_urgency_approvals','UPDATE')
    OR has_table_privilege('cerp_app','public.delivery_urgency_withdrawals','UPDATE')
    OR has_table_privilege('cerp_app','public.delivery_urgency_transfers','UPDATE')
    OR to_regclass('public.delivery_urgency_active_beneficiary_idx') IS NULL
    OR (SELECT count(*) FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND NOT tgisinternal AND tgenabled='O' AND tgname IN
      ('delivery_urgency_request_identity','delivery_urgency_recoveries_immutable','delivery_urgency_sources_immutable',
       'delivery_urgency_recovery_identity','delivery_urgency_source_identity',
       'delivery_urgency_request_quantities','delivery_urgency_recovery_quantities','delivery_urgency_source_quantities',
       'delivery_urgency_approvals_immutable','delivery_urgency_approval_identity',
       'delivery_urgency_withdrawals_immutable','delivery_urgency_transfers_immutable','delivery_urgency_withdrawal_identity',
       'delivery_urgency_transfer_identity','delivery_urgency_withdrawal_balance','delivery_urgency_transfer_balance'))<>16 THEN
    RAISE EXCEPTION 'Urgency immutable evidence, identity, quantity guards or active-request index missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_requests request WHERE request.quantity IS DISTINCT FROM
    (SELECT COALESCE(sum(quantity),0) FROM public.delivery_urgency_recoveries WHERE request_id=request.id))
    OR EXISTS(SELECT 1 FROM public.delivery_urgency_recoveries recovery WHERE recovery.quantity IS DISTINCT FROM
      (SELECT COALESCE(sum(quantity),0) FROM public.delivery_urgency_sources WHERE recovery_id=recovery.id)) THEN
    RAISE EXCEPTION 'Urgency request/recovery/source quantities do not balance';
  END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_withdrawals withdrawal
    JOIN public.delivery_urgency_requests request ON request.id=withdrawal.request_id
    WHERE request.status<>'WITHDRAWN' OR request.withdrawn_id IS DISTINCT FROM withdrawal.id
      OR withdrawal.quantity IS DISTINCT FROM (SELECT COALESCE(sum(quantity),0) FROM public.delivery_urgency_transfers WHERE withdrawal_id=withdrawal.id)) THEN
    RAISE EXCEPTION 'Urgency withdrawal is not atomically completed';
  END IF;
END $$;
ROLLBACK;
