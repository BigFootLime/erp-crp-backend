# Customer-order workflow owner — U11

`commande-workflow.repository.ts` owns the customer-order workflow and
checkpoint family: status history transitions, checkpoint materialization,
technical-review retirement, checkpoint update/action transactions, and their
workflow-private mapping and notification helpers.

The public exports remain on `commande-client.repository.ts`. Its compatibility
facade creates the owner once with the four genuinely facade-local seams:
integer conversion, nullable integer conversion, command-event recording, and
the stock analysis transaction. This keeps the historic transaction owner,
locks, audit/event recording, outbox sequencing, idempotent replay and pool
lookup timing intact. The owner never imports the facade.

Stable dependencies remain direct imports of the owner: workflow definitions,
RBAC, readiness guards, realtime transaction/outbox and notifications. Private
launch helpers used by the remaining facade stay internal facade bindings, not
new public exports. No SQL, endpoint, role policy, Quality visa, stock,
purchase, lot-quality permission, migration, service, deployment or
installation behavior changes in this extraction.

The moved body is mechanically retained from candidate
`fb9a0505b07ab64c970b887e1cb89c0679fd12e7`; only the owner boundary and
typed dependency binding differ. The qualified build requires a complete local
dependency graph. The isolated worktree's inherited dependency junction was
already stale (its target was absent), so its broad typecheck and Vitest run
stop at dependency resolution rather than the U11 sources; focused compiler
analysis with a valid frozen dependency graph reports no diagnostic in either
workflow owner or facade.
