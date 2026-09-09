# Recovery — consommable OF revision identity

Apply after `20260909_consumable_procurement.sql`, with a verified backup and the preflight queries. Schema change and initial attachment are one transaction. On failure, roll back that transaction.

After writes, retain the new column, index, revisions and reconciliation histories. Do not drop the column or reassign committed needs to another active revision to hide a mismatch. Restore the previous application only after checking how it displays commitments; prefer a forward correction. Production restore is a separate, explicitly authorized operation.
