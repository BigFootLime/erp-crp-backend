# Recovery — partial deliveries (#1124)

Run the preflight, canonical patch and verify through the reviewed migration runner after the normal backup. The patch creates the scoped unique index before removing the obsolete global index, in one transaction with bounded locks. No business rows or historical allocation identifiers are changed. Failure rolls the schema change back.

The older 20260724 patch remains immutable; dependency ordering ensures it runs before this correction on a fresh database. Keep the correction installed when rolling back application code. The explicit schema rollback refuses once one reservation has multiple allocations, even if one BL was cancelled. Never delete allocations, shipments, movements or promise evidence to force rollback. Resolve a post-deployment defect by rolling forward.
