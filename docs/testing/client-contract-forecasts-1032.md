# #1032 — Common acceptance preparation

Business/UI acceptance prepared, NOT RUN: the user asked to reserve combined tests until the complete flow is implemented.

- Create a monthly estimate from an active client contract, including an explicit zero; retain the selected family/unit and article snapshot.
- Revise quantity/due/customer-estimate date; preserve the old version and require a reason. Reject an impossible date, more than three quantity decimals, a due date outside the month/contract, unknown/inactive article, another client/contract and stale versions.
- Concurrent creates of the same line/month must not duplicate. Exact retry returns the first result; different body with same key is rejected. After uncertain commit, reopen and replay the original request, including a new estimate whose saved source is null.
- Withdraw/reactivate with retained history. Inactive client/contract cannot write. Retained estimates protect contract-family/unit identity; historical estimates remain readable when a line is inactive or its current article is unavailable.
- Pagination/filter/history have loading, empty/error/retry, permission and keyboard states. Check bureau/tablette, clair/sombre in the final common UI recipe.
- Estimates must cause no order, OF, stock move or reservation. Conversion, coverage calculation and replenishment generation are separate pending increments.

Incremental release evidence: TypeScript/lint, immutable builds/OpenAPI, migration and SQL PREPARE using a temporary schema-only database, guarded unused rollback, preflight/verify, fresh backup and runtime readiness. Record actual results; never describe a PREPARE as a business/concurrency test.
