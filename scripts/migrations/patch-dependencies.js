// Deployed filenames and checksums stay immutable. Dependencies take precedence
// over their historical filename order in every migration entry point.
const DEPENDENCIES = Object.freeze({
  "20261008_consolidation_material_holds_937.sql": ["20261007_consolidation_material_transfers_815.sql", "20260909_consumable_need_reservations.sql"],
  "20261008_planning_forecast_resources_931.sql": ["20260908_material_forecasts.sql"],
  "20261008_client_crm_925.sql": ["20260720_clients_360_hardening.sql", "20260804_realtime_control_plane_v2.sql"],
  "20261007_admin_account_recovery_901.sql": ["20260218_password_resets.sql", "20260811_account_provisioning_schema_repair.sql", "20260816_mfa_policy_and_device_labels.sql", "20260726_shopfloor_station_159.sql", "20260908_android_terminals_1038.sql"],
  "20261007_purchase_preparations_902.sql": ["20260907_of_material_coverage.sql", "20260908_material_debits.sql", "20260909_consumable_of_revision.sql"],
  "20261007_native_cutting_terminals_896.sql": ["20260909_supply_terminals.sql", "20261007_material_source_yield_877.sql"],
  "20261007_maintenance_schedule_888.sql": ["20260722_machine_park_165.sql", "20260906_planning_central.sql", "20260908_material_debits.sql"],
  "20261007_material_source_yield_877.sql": ["20260908_material_debits.sql", "20260908_material_remnants.sql", "20261007_production_flow_822.sql"],
  "20260921_articles_purchase_flow.sql": ["20260914_receipt_processing_1069.sql", "20260909_consumable_procurement.sql"],
  "20260914_receipt_processing_1069.sql": ["20260908_receipt_unit_snapshot.sql", "20260909_consumable_need_reservations.sql", "20260907_of_material_coverage.sql", "20260823_subcontract_work_packages_626.sql"],
  "20260908_consultation_documents.sql": ["20260908_supplier_consultations.sql"],
  "20260909_consumable_procurement.sql": ["20260909_consumables.sql"],
  "20260909_grouped_supplier_receipts.sql": ["20260909_consumable_procurement.sql"],
  "20260909_consumable_need_reservations.sql": ["20260909_grouped_supplier_receipts.sql"],
  "20260909_consumable_of_revision.sql": ["20260909_consumable_need_reservations.sql"],
  "20260909_supply_terminals.sql": ["20260908_android_terminals_1038.sql"],
});

function orderPatchDependencies(filenames) {
  const present = new Set(filenames);
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(filename) {
    if (visited.has(filename)) return;
    if (visiting.has(filename)) throw new Error(`Cyclic migration dependency: ${filename}`);
    visiting.add(filename);
    for (const prerequisite of DEPENDENCIES[filename] ?? []) {
      // A selected inventory can rely on prerequisites already in the database.
      if (present.has(prerequisite)) visit(prerequisite);
    }
    visiting.delete(filename);
    visited.add(filename);
    ordered.push(filename);
  }
  filenames.forEach(visit);
  return ordered;
}

module.exports = { DEPENDENCIES, orderPatchDependencies };
