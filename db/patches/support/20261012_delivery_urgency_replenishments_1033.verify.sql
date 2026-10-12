BEGIN READ ONLY;
DO $$ BEGIN
  IF to_regclass('public.delivery_urgency_replenishments') IS NULL THEN
    RAISE EXCEPTION 'Urgency replenishment evidence missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.delivery_urgency_recoveries r
    JOIN public.delivery_urgency_replenishments p ON p.recovery_id=r.id
    GROUP BY r.id,r.quantity HAVING sum(p.quantity)>r.quantity) THEN
    RAISE EXCEPTION 'Urgency recovery counted beyond its borrowed quantity';
  END IF;
  IF has_table_privilege('cerp_app','public.delivery_urgency_replenishments','UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Replenishment evidence permissions too broad';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgname IN('delivery_urgency_replenishments_immutable','delivery_urgency_replenishment_identity',
      'delivery_urgency_replenishment_receipt'))<>3 THEN
    RAISE EXCEPTION 'Replenishment guard missing';
  END IF;
END $$;
ROLLBACK;
