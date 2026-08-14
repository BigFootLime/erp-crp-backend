# Inventaire des migrations — SOL-06

- Généré : 2026-08-14T11:07:49.191Z
- Source : filesystem scan of db/patches and db/patches/support
- Patches exécutables : 156
- Scripts auxiliaires : 260
- Patches depuis 2026-07-01 : 98

## Risques statiques à examiner

| Classe | Nombre de patches |
|---|---:|
| DDL destructif | 2 |
| DML destructif | 8 |
| Réécriture de données | 92 |
| Verrou de table possible | 126 |
| Index non concurrent | 117 |
| Évolution d'enum | 1 |

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

Le détail machine, l'ordre, les SHA-256, la transaction, la rejouabilité et les risques par fichier sont dans `MIGRATION_INVENTORY_SOL_06.json`.
