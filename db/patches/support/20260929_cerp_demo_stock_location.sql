BEGIN;
DO $$ BEGIN IF current_database() <> 'cerp_demo' THEN RAISE EXCEPTION 'Demo database required'; END IF; END $$;
UPDATE public.magasins m SET warehouse_id=w.id FROM public.warehouses w WHERE m.code='DEMO-MAG' AND w.code='DEMO-MAG' AND m.warehouse_id IS NULL;
UPDATE public.emplacements e SET location_id=l.id FROM public.locations l, public.magasins m WHERE e.magasin_id=m.id AND m.code='DEMO-MAG' AND l.warehouse_id=m.warehouse_id AND e.code='DEMO-A01' AND l.code='DEMO-A01' AND e.location_id IS NULL;
INSERT INTO public.erp_settings(key,value_text) SELECT 'stock.default_receipt_location',e.location_id::text FROM public.emplacements e JOIN public.magasins m ON m.id=e.magasin_id WHERE m.code='DEMO-MAG' AND e.code='DEMO-A01' AND e.location_id IS NOT NULL ON CONFLICT(key) DO NOTHING;
COMMIT;
