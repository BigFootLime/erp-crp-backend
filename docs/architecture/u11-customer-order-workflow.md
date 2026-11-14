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

The moved declarations retain their complete bodies and signatures from
`fb9a0505b07ab64c970b887e1cb89c0679fd12e7`, with two spaces of factory nesting.
This adds common indentation to multiline SQL text; the preservation proof
normalizes only that indentation and does not claim byte-identical SQL strings.
Qualification uses a complete frozen dependency installation and the actual
strict project build, including its emitted CommonJS dependency graph.

The empty-routing contract checks mandatory planning on the actual complete
`repairLegacyNoOperationPlanningBypass` body in this owner, and verifies that
the facade still invokes it. All four existing contract cases and their
planning, archive and warning assertions remain in place.
