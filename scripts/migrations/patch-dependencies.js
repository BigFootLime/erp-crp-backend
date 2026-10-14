// Deployed filenames and checksums stay immutable. Dependencies take precedence
// over their historical filename order in every migration entry point.
const DEPENDENCIES = Object.freeze({
  "20261013_proforma_affair_funding_1268.sql": ["20261014_finance_ged_profile_1268.sql"],
  "20261014_finance_ged_profile_1268.sql": ["20260823_authoritative_pdf_ged_legacy_profile_cleanup.sql"],
  "20261014_refund_reversals_1268.sql": ["20261014_advance_amount_credits_1268.sql"],
  "20261014_advance_amount_credits_1268.sql": ["20261014_customer_refunds_1268.sql"],
  "20261014_customer_refunds_1268.sql": ["20261014_advance_cash_vat_1268.sql"],
  "20261014_advance_cash_vat_1268.sql": ["20261013_proforma_affair_funding_1268.sql", "20261014_finance_line_precision_1268.sql"],
  "20261014_workshop_print_dispatch_1320.sql": ["20261014_of_workshop_folders_1320.sql", "20260907_of_dossier_completion.sql"],
  "20261014_of_workshop_folders_1320.sql": ["20261014_of_document_print_intents_1320.sql"],
  "20261014_of_document_print_intents_1320.sql": ["20260729_of_versioning_replanification_ar_370.sql"],
  "20261013_minor_stock_compatibility_1294.sql": ["20261007_history_packaging_832.sql"],
  "20261013_material_bar_identity_1256.sql": ["20261012_material_bar_identification_1248.sql", "20261012_physical_material_bar_movements_1246.sql"],
  "20261012_material_bar_identification_1248.sql": ["20261012_physical_material_bar_quality_1246.sql", "20260814_identification_labels_sol30.sql"],
  "20261012_physical_material_bar_quality_1246.sql": ["20261012_physical_material_bar_movements_1246.sql"],
  "20261012_physical_material_bar_counts_1246.sql": ["20261012_physical_material_bar_movements_1246.sql", "20260901_stock_inventory_draft_adjustments.sql"],
  "20261012_physical_material_bar_movements_1246.sql": ["20261012_physical_material_bars_1246.sql"],
  "20261012_physical_material_bars_1246.sql": ["20260723_stock_traceability_225.sql", "20260908_material_debits.sql"],
  "20261012_recovery_consolidation_additions_1034.sql": ["20261012_recovery_material_extensions_1034.sql", "20260907_of_dossier_completion.sql"],
  "20261012_recovery_material_extensions_1034.sql": ["20261012_delivery_urgency_requests_1033.sql", "20261008_consolidation_material_holds_937.sql"],
  "20261012_delivery_urgency_replenishments_1033.sql": ["20261012_delivery_urgency_requests_1033.sql", "20261009_production_receipt_lane_assignments_1029.sql"],
  "20261012_delivery_urgency_restitutions_1033.sql": ["20261012_delivery_urgency_fees_1033.sql", "20261012_delivery_urgency_replenishments_1033.sql"],
  "20261012_delivery_urgency_requests_1033.sql": ["20261009_stock_lane_routing_1028.sql", "20261010_reservation_shipments_promises_1109.sql", "20260905_production_preparation_consolidation_05_grants.sql", "20261008_stock_valuation_journal_977.sql"],
  "20261012_delivery_urgency_fees_1033.sql": ["20261012_delivery_urgency_requests_1033.sql", "20260804_finance_settlement_state_469.sql"],

  "20261011_finance_issuer_directory_1219.sql": ["20260827_einvoice_regulatory_data_599.sql"],
  "20261010_partial_delivery_reservation_scope_1124.sql": ["20260724_expedition_deliveries_226.sql", "20260826_commandes_stock_reservations_livraisons_atomic.sql"],
  "20261010_client_replenishment_fixed_lots_1032.sql": ["20261010_client_replenishment_roots_1032.sql"],
  "20261010_client_replenishment_roots_1032.sql": ["20261010_client_replenishment_preparations_1032.sql", "20260905_production_preparation_consolidation_05_grants.sql"],
  "20261010_client_replenishment_preparations_1032.sql": ["20261009_client_forecast_conversions_1032.sql"],
  "20261009_client_forecast_conversions_1032.sql": ["20261009_client_contract_forecasts_1032.sql"],
  "20261009_client_contract_forecasts_1032.sql": ["20261009_client_contract_calls_1031.sql"],
  "20261009_client_contract_legacy_1031.sql": ["20261009_client_contract_calls_1031.sql", "20260218_commandes_clients_types_groupage.sql"],
  "20261009_client_contract_calls_1031.sql": ["20261009_client_contract_catalog_1031.sql", "20260902_customer_order_reconciliation_698.sql"],
  "20261009_client_contract_catalog_1031.sql": ["20261009_stock_lane_locations_1028.sql", "20261008_client_crm_925.sql", "20260804_article_unit_stock_contract.sql"],
  "20261009_stock_lane_routing_1028.sql": ["20261009_stock_lane_locations_1028.sql", "20261009_production_receipt_lane_assignments_1029.sql"],
  "20261009_stock_lane_locations_1028.sql": ["20260723_stock_traceability_225.sql", "20260826_z_lots_scope_canonicalization.sql", "20260904_customer_order_assembly_planning.sql"],
  "20261009_production_receipt_lane_assignments_1029.sql": ["20261009_stock_lane_locations_1028.sql", "20261007_delivery_promises_821.sql", "20260904_customer_order_assembly_planning.sql"],
  "20261008_stock_invoice_reconciliations_1022.sql": ["20261008_stock_value_adjustments_1007.sql", "20261008_stock_order_transport_1016.sql"],
  "20261008_stock_value_adjustments_1007.sql": ["20261008_stock_opening_bases_1004.sql"],
  "20261008_stock_order_transport_1016.sql": ["20261008_stock_acquisition_sources_980.sql"],
  "20261008_stock_opening_bases_1004.sql": ["20261008_stock_manufacturing_allocations_1001.sql"],
  "20261008_stock_manufacturing_allocations_1001.sql": ["20261008_stock_manufacturing_bases_998.sql"],
  "20261008_stock_manufacturing_bases_998.sql": ["20261008_stock_manufacturing_sources_995.sql"],
  "20261008_stock_manufacturing_sources_995.sql": ["20261008_stock_return_sources_986.sql", "20260723_production_receipts_223.sql", "20260726_production_execution_274.sql", "20260805_margin_engine_0001.sql", "20260811_margin_traceability_0002.sql"],
  "20261008_stock_return_sources_986.sql": ["20261008_stock_cump_projection_983.sql", "20261007_material_source_yield_877.sql"],
  "20261008_stock_cump_projection_983.sql": ["20261008_stock_acquisition_sources_980.sql"],
  "20261008_stock_acquisition_sources_980.sql": ["20261008_stock_valuation_journal_977.sql", "20260721_commandes_fournisseurs_core.sql", "20260908_receipt_unit_snapshot.sql", "20260914_receipt_processing_1069.sql"],
  "20261008_stock_valuation_journal_977.sql": ["20260223_stock_movements_apply_on_posted.sql", "20260723_stock_traceability_225.sql", "20260804_article_unit_stock_contract.sql"],
  "20261008_quote_margin_source_snapshots_941.sql": ["20260325_devis_versioning_and_line_ownership.sql", "20260805_margin_engine_0001.sql", "20260811_margin_traceability_0002.sql"],
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
