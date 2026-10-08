export const ASSEMBLY_RETURN_PROOF_SQL = `SELECT original.id FROM public.of_material_consumptions original
  JOIN public.of_material_consumptions inverse ON inverse.id=original.compensated_by_id AND inverse.compensates_id=original.id
  JOIN public.stock_movements movement ON movement.id=inverse.stock_movement_id AND movement.reversal_of_id=original.stock_movement_id
  WHERE original.stock_movement_id=$1::uuid AND inverse.stock_movement_id=$2::uuid
    AND original.of_id=$3 AND original.reservation_id=$4::uuid AND original.qty=$5::numeric
    AND original.status='COMPENSATED' AND inverse.status='POSTED' AND inverse.qty=original.qty
    AND inverse.article_id=original.article_id AND inverse.lot_id=original.lot_id AND inverse.unit_code=original.unit_code
    AND movement.status::text='POSTED' AND movement.movement_type::text='IN'`;
