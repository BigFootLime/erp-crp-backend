-- Compatibility seed for GED profiles that have the closed entity registry
-- and their canonical triggers, but do not enable the later EC link guard.
-- It deliberately changes neither trigger nor function definitions.
BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.ged_entity_types') IS NULL
     OR to_regclass('public.metrologie_equipements') IS NULL
     OR to_regclass('public.ged_document_links') IS NULL THEN
    RAISE EXCEPTION 'METROLOGIE_GED_ENTITY_TYPE_COMPAT_PREREQUISITE_MISSING';
  END IF;
END
$guard$;

INSERT INTO public.ged_entity_types
  (entity_type, label, module_key, target_table, target_pk_column, sort_order, is_active)
VALUES
  ('METROLOGIE_EQUIPEMENT', 'Équipement de métrologie', 'metrologie', 'metrologie_equipements', 'id', 115, true)
ON CONFLICT (entity_type) DO UPDATE
SET label = EXCLUDED.label,
    module_key = EXCLUDED.module_key,
    target_table = EXCLUDED.target_table,
    target_pk_column = EXCLUDED.target_pk_column,
    sort_order = EXCLUDED.sort_order,
    is_active = true,
    updated_at = now()
WHERE (
  public.ged_entity_types.label,
  public.ged_entity_types.module_key,
  public.ged_entity_types.target_table,
  public.ged_entity_types.target_pk_column,
  public.ged_entity_types.sort_order,
  public.ged_entity_types.is_active
) IS DISTINCT FROM (
  EXCLUDED.label,
  EXCLUDED.module_key,
  EXCLUDED.target_table,
  EXCLUDED.target_pk_column,
  EXCLUDED.sort_order,
  EXCLUDED.is_active
);

COMMIT;
