# Canonical assembly operation (#1146)

WP285 / S03 / OBS085. Normal recipe creation exposed an inconsistent contract: the route API and database CHECK reject ASSEMBLAGE, but component consumption and the terminal require that exact type in the frozen snapshot. A route labelled Autre cannot satisfy this business rule.

The additive type expansion preserves the nine existing values and nullable historical operations. Migration `20261011_gamme_assembly_operation_type_1146.sql` expands the existing CHECK without modifying older checksummed patches, operations or frozen dossiers. The normal creation/revision/publication flow remains the only route to a new applicable definition.

A montage without a CNC family can use its explicitly assigned autonomous workstation. The central eligible-resource projection and planning command apply the same rule. An inactive, archived, unassigned or machine-backed workstation remains invalid; all CNC-family, quality and component gates remain in force.

Before deployment: verify the migration ledger, take and verify Test/Prod backups, run the read-only preflight and record the exact candidate build. Apply through the recorded migration runner before serving the paired frontend type option (web1384). Run the verify script, check backend readiness and actual public/HYPERBOX2 versions, then replay ENS creation/update/publication in Base Test. Do not change production recipe records.

Rollback restores the old CHECK only when no ASSEMBLAGE operation exists. Its table lock makes the presence check and narrowing atomic. Otherwise it fails with ASSEMBLY_OPERATION_ROLLBACK_REQUIRES_REVIEW without deleting or translating any operation. A runtime rollback can retain the additive CHECK; review any route already using the new type before installing an older frontend.

Evidence: strict builds; validator and operation-dialog checks; actual PostgreSQL CHECK expansion, preservation, invalid input, repeated application, frozen reader, planning qualification and guarded rollback. These are scoped checks, not a complete manufacturing/lane/invoicing PASS. The full recipe remains IN_PROGRESS until actual component output and stock transitions are exercised.
