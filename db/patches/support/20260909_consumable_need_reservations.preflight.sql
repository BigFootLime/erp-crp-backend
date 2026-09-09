SELECT current_database(),current_user;
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='stock_reservations' AND indexname LIKE '%active%lot%';
SELECT material_need_id,article_id,location_id,lot_id,count(*) FROM public.stock_reservations
  WHERE status='ACTIVE' AND material_need_id IS NOT NULL AND lot_id IS NOT NULL GROUP BY 1,2,3,4 HAVING count(*)>1;
