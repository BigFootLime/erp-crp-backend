# Inventaire des migrations — SOL-06

- Généré : 2026-10-20T12:04:39.904Z
- Source : filesystem scan of db/patches and db/patches/support
- Patches exécutables : 322
- Scripts auxiliaires : 701
- Patches depuis 2026-07-01 : 264

## Risques statiques à examiner

| Classe | Nombre de patches |
|---|---:|
| DDL destructif | 3 |
| DML destructif | 38 |
| Réécriture de données | 209 |
| Verrou de table possible | 229 |
| Index non concurrent | 214 |
| Évolution d'enum | 2 |

Ces détections sont volontairement conservatrices : elles servent de file de revue, pas de preuve de danger. Les durées réelles sont capturées par la répétition isolée.

## Couverture auxiliaire récente incomplète

- `20260706_affaire_allow_projet.sql`: preflight=false, verify=false, rollback=false
- `20260707_devis_statut_enum.sql`: preflight=false, verify=false, rollback=false
- `20260707_pieces_techniques_gpao_versions_gammes.sql`: preflight=false, verify=true, rollback=true
- `20260708_gpao_achats_type.sql`: preflight=false, verify=false, rollback=true
- `20260708_gpao_gammes_operations_types.sql`: preflight=false, verify=false, rollback=true
- `20260708_gpao_nomenclature_versioned.sql`: preflight=false, verify=false, rollback=true
- `20260708_gpao_piece_article_unique.sql`: preflight=false, verify=false, rollback=true
- `20260708_gpao_versions_lifecycle.sql`: preflight=false, verify=false, rollback=true
- `20260709_hr_temps_deplacements.sql`: preflight=false, verify=false, rollback=false
- `20260710_hr_users_role_responsable_rh.sql`: preflight=false, verify=false, rollback=false
- `20260710_project_office_core.sql`: preflight=false, verify=true, rollback=true
- `20260710_project_office_report.sql`: preflight=false, verify=true, rollback=true
- `20260710_project_office_report_files.sql`: preflight=false, verify=false, rollback=false
- `20260720_clients_360_hardening.sql`: preflight=false, verify=true, rollback=true
- `20260721_clients_compta_fields.sql`: preflight=false, verify=true, rollback=true
- `20260722_of_work_orders_170.sql`: preflight=false, verify=true, rollback=true
- `20260726_metrologie_360_229.sql`: preflight=false, verify=false, rollback=true
- `20260727_user_account_profile_optional_315.sql`: preflight=false, verify=true, rollback=true
- `20260729_finance_legal_mentions_hardening_221.sql`: preflight=false, verify=false, rollback=false
- `20260729_of_visa_controle_370.sql`: preflight=false, verify=false, rollback=false
- `20260730_account_module_access_262.sql`: preflight=true, verify=true, rollback=false
- `20260730_piece_technique_pf_internal_family_404.sql`: preflight=true, verify=true, rollback=false
- `20260730_repair_module_catalog_visibility_402.sql`: preflight=true, verify=true, rollback=false
- `20260730_surface_finish_family_comment_244.sql`: preflight=true, verify=true, rollback=false
- `20260801_piece_version_guided_publish_trigger.sql`: preflight=false, verify=true, rollback=true
- `20260826_commandes_stock_reservations_livraisons_atomic.sql`: preflight=false, verify=true, rollback=true
- `20260826_pt_article_lot_reference_enrichment.sql`: preflight=false, verify=true, rollback=false
- `20260826_z_lots_scope_canonicalization.sql`: preflight=false, verify=true, rollback=false
- `20260826_zz_historical_stock_imports.sql`: preflight=false, verify=true, rollback=true
- `20260831_stock_article_inventory_revision_ux.sql`: preflight=false, verify=true, rollback=true
- `20260905_production_preparation_consolidation_01.sql`: preflight=false, verify=false, rollback=false
- `20260905_production_preparation_consolidation_02.sql`: preflight=false, verify=false, rollback=false
- `20260905_production_preparation_consolidation_03.sql`: preflight=false, verify=false, rollback=false
- `20260905_production_preparation_consolidation_04.sql`: preflight=false, verify=false, rollback=false
- `20260905_production_preparation_consolidation_05_grants.sql`: preflight=false, verify=false, rollback=false
- `20260907_finish_code_scope_749.sql`: preflight=true, verify=true, rollback=false
- `20260907_ged_superadmin_approval_758.sql`: preflight=true, verify=true, rollback=false
- `20260907_inventory_trace_grant_752.sql`: preflight=true, verify=true, rollback=false
- `20260907_of_dossier_completion.sql`: preflight=true, verify=true, rollback=false
- `20260907_of_material_coverage.sql`: preflight=true, verify=true, rollback=false
- `20260907_of_material_lot_verification.sql`: preflight=true, verify=true, rollback=false
- `20260908_android_automatic_time_1038.sql`: preflight=false, verify=false, rollback=false
- `20260908_android_terminals_1038.sql`: preflight=true, verify=true, rollback=false
- `20260908_supplier_consultations.sql`: preflight=true, verify=true, rollback=false
- `20260908_consultation_documents.sql`: preflight=true, verify=true, rollback=false
- `20260908_customer_material_calls.sql`: preflight=true, verify=true, rollback=false
- `20260908_material_debits.sql`: preflight=true, verify=true, rollback=false
- `20260908_material_forecasts.sql`: preflight=true, verify=true, rollback=false
- `20260908_material_future_offsets.sql`: preflight=true, verify=true, rollback=false
- `20260908_material_need_history.sql`: preflight=true, verify=true, rollback=false
- `20260908_material_remnants.sql`: preflight=true, verify=true, rollback=false
- `20260908_material_revision_reconciliation.sql`: preflight=true, verify=true, rollback=false
- `20260908_operation_program_guard.sql`: preflight=true, verify=true, rollback=false
- `20260908_quality_lot_context.sql`: preflight=true, verify=true, rollback=false
- `20260908_receipt_unit_snapshot.sql`: preflight=true, verify=true, rollback=false
- `20260909_consumables.sql`: preflight=true, verify=true, rollback=false
- `20260909_consumable_procurement.sql`: preflight=true, verify=true, rollback=false
- `20260909_grouped_supplier_receipts.sql`: preflight=true, verify=true, rollback=false
- `20260909_consumable_need_reservations.sql`: preflight=true, verify=true, rollback=false
- `20260909_consumable_of_revision.sql`: preflight=true, verify=true, rollback=false
- `20260909_supply_terminals.sql`: preflight=true, verify=true, rollback=false
- `20261006_of_completion_before_planning.sql`: preflight=true, verify=true, rollback=false
- `20261007_material_source_yield_877.sql`: preflight=true, verify=true, rollback=false
- `20261010_recipe_numeric_precision_1062.sql`: preflight=false, verify=true, rollback=true
- `20261012_delivery_urgency_requests_1033.sql`: preflight=false, verify=true, rollback=true
- `20261012_delivery_urgency_fees_1033.sql`: preflight=false, verify=true, rollback=true
- `20261012_delivery_urgency_replenishments_1033.sql`: preflight=false, verify=true, rollback=true
- `20261012_delivery_urgency_restitutions_1033.sql`: preflight=false, verify=true, rollback=true
- `20261012_recovery_material_extensions_1034.sql`: preflight=false, verify=true, rollback=true
- `20261012_recovery_consolidation_additions_1034.sql`: preflight=false, verify=true, rollback=true
- `20261013_empty_quality_execution_cancellation_1276.sql`: preflight=false, verify=true, rollback=true
- `20261013_material_bar_identity_1256.sql`: preflight=false, verify=true, rollback=true
- `20261013_subcontract_operation_completion_1273.sql`: preflight=false, verify=true, rollback=true
- `20261013_subcontract_origin_packages_1269.sql`: preflight=false, verify=true, rollback=true

Le détail machine, l'ordre, les SHA-256, la transaction, la rejouabilité et les risques par fichier sont dans `MIGRATION_INVENTORY_SOL_06.json`.
