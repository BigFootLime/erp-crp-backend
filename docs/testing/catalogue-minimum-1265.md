# Supplier MOQ across material origins — #1265 / WP288

Actual Test preparation of OF1238 was blocked: the same treatment ordered as two traceability lines of18 and2 pieces was compared separately against the supplier's minimum order quantity4. Cutting and turning had already completed20 pieces.

Batch insertion now provides a server-computed quantity for the same catalogue, article and unit inside its supplier/currency/destination order group. Ordinary additions and edits read existing active quantities from the same locked order, excluding the edited line and cancelled quantities. The price snapshot keeps MOQ4; unit tiers, flat fees and minimum billing remain governed by the existing per-line calculation. No quantities, origin identities, prices or permission rules are rewritten to overcome the minimum.

Submission, approval and sending recheck the current active order groups, including cancelled quantities. Quantity from another article, catalogue, unit or order cannot satisfy the target group's minimum. Existing order-header locking serializes concurrent mutations; procurement idempotency remains unchanged. No public input can supply the aggregate quantity. No API or schema migration.

Validation:27 focused tests,101 supplier/subcontract regressions, full backend build. `scripts/tests/catalogue-minimum-1265.repository.cjs` invokes the actual subcontract preparation, quote/pricing, identity validation and line-update repositories against a literal owned restored fixture. Ten real PostgreSQL checks pass:18+2, concurrent/replayed creation, validation after predecessor closure, resubmitting quantity2 without double counting, the edited origin's own cancelled quantity, cancellation/other-article isolation,2+18, and insufficient2 with rollback. Its wrapper drops only the fixture database it created; live Test and Prod remain unchanged. PDF tasks stay inside the temporary database; no external mail or document worker is launched.

The live UI replay and deployment remain required before closing MAT1265 or the complete recipe scenario. The original blocked capture is retained.
