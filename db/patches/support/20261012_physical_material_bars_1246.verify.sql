SELECT stock_batch_id,movement_count,row_version,confirmed_by FROM public.stock_material_bar_inventories LIMIT 0;
SELECT id,stock_batch_id,initial_length_mm,remaining_length_mm,row_version,retired_at FROM public.stock_material_bars LIMIT 0;
SELECT bar_id,reservation_id,remaining_length_mm FROM public.stock_material_bar_reservations LIMIT 0;
SELECT bar_id,command_key,action,stock_movement_id,before_state,after_state,created_by FROM public.stock_material_bar_events LIMIT 0;
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('stock_material_bar_events_1246_immutable','stock_material_bar_capacity_1246','stock_material_bar_hold_capacity_1246','stock_material_bar_hold_total_1246','stock_material_bar_reservation_total_1246','stock_material_bar_identity_1246','stock_material_bar_hold_identity_1246') AND NOT tgisinternal AND tgenabled<>'D')<>7 THEN
    RAISE EXCEPTION 'Physical bar integrity triggers are missing or disabled';
  END IF;
END $$;
