-- Read-only post-apply proof for the GED link guard contract.
SELECT entity_type, label, module_key, target_table, target_pk_column, sort_order, is_active
FROM public.ged_entity_types
WHERE entity_type = 'METROLOGIE_EQUIPEMENT';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ged_entity_types
    WHERE entity_type = 'METROLOGIE_EQUIPEMENT'
      AND module_key = 'metrologie'
      AND target_table = 'metrologie_equipements'
      AND target_pk_column = 'id'
      AND sort_order = 115
      AND is_active = true
  ) THEN
    RAISE EXCEPTION 'METROLOGIE_GED_ENTITY_TYPE_1780_CONTRACT_MISMATCH';
  END IF;
END
$verify$;
