# Recovery — minor stock compatibility 1294

Record fresh verified Test/Production dumps on the VPS and the canonical full recovery-set evidence before applying through the migration ledger. Run the preflight and verify scripts on each database. The patch changes one read-only view and its existing SELECT grant; no lot, stock quantity, reservation, quality decision, order snapshot or document is rewritten.

Qualification must execute the actual recursive query on PostgreSQL: both directions, transitivity and branches of approved non-impacting MINOR links; refusal across MAJOR, another piece/indice, impacting/unknown impact or unapproved status; unique pairs and cycle termination. Verify the real Test command preview and use the normal audited reservation endpoint/UI.

A binary rollback keeps this view: older consumers already use its identical two-UUID-column contract. A semantic rollback must first be reviewed against reservations created during this release, then use the companion view-only SQL; it never reverses business movements or changes the migration ledger. Do not restore a database automatically. Prefer a forward repair if later evidence changes a lineage decision.
