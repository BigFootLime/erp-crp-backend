# Routing identity in planning snapshot — #1203 / WP-287

Frontend #1440 needs to show individual FRAISAGE, TOURNAGE and REPRISE operations in the machine view, separate from manual operations and whole draft OFs.

The snapshot already carries `phase` from the canonical `op.phase` (#1433). It now also exposes optional nullable `operationType` from the frozen routing value read by the existing machine-qualification query. It is not inferred from designation text or a machine name. A missing frozen definition returns null. Programming/draft tasks do not acquire a made-up operation type.

The qualification-derived operation type participates in the task version for internal operations, alongside eligible resources. Existing previews must be recalculated after this deployment if their expected versions differ. No schema change, authentication/RBAC change or alternate scheduling protocol. The server still validates resource compatibility and recalculates before apply.

The targeted repository test covers frozen FRAISAGE/TOURNAGE/REPRISE/CONTROLE/SOUS_TRAITANCE/unknown, preserves the misleading free-text designation and does not modify its source row. TypeScript build and planning engine/version/phase/timestamp checks are required before publication. Test and Prod deployment evidence is distinct from the overall ERP recipe, which remains in progress.
