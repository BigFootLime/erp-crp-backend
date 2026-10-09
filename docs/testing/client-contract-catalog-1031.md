# Client contract catalog — acceptance prepared, not executed

The user requested a combined business/UI acceptance after the complete flow. No real client contract or business transaction is created as a deployment smoke test.

Technical release checks: scoped source typecheck/build and OpenAPI inventory; migration preflight, additive application and verification on Test then Prod; read-only SQL PREPARE against the migrated schema; pinned frontend/backend revisions and health checks. Fresh backup evidence is mandatory before production schema changes.

## Combined recipe

1. Open a client in Base test. Add two contracts with distinct references, dates and batches. Select articles with the canonical searchable CERP field; other clients' articles and unvalidated versions must be unavailable.
2. Verify required quantity, three-decimal limit, real dates, date order and duplicate commercial-family rejection. No arbitrary default batch should be supplied.
3. Reopen the definition. Confirm article code, designation, saved index, canonical unit and batch; close and recreate the dialog without losing selected labels.
4. Modify in two sessions. One accepted version must succeed; the stale version must require refresh with no partial changes. The history identifies actor, date, reason, before/after and saved technical version.
5. Simulate an uncertain network result. Retry exactly the captured body/key; confirm a single event and unchanged original result. Changed body with the same key must conflict.
6. Apply a newly validated index in the same family. The future proposal changes; old history, order, OF and BL evidence do not. Unit incompatibility or missing validated definition must be visible.
7. Close with a reason. History remains readable. Editing a closed contract or mutating a blocked/inactive client must fail. A duplicate reference, including case-only changes, must be rejected within that client.
8. Read-only roles cannot write; Base test/prod and user switches unmount editors and preserve request database headers. Realtime changes refresh the canonical client queries.

Firm-order calls, historical CADRE bindings, forecasts and BL guards remain separate pending increments. Do not report this recipe PASS until performed and documented.
