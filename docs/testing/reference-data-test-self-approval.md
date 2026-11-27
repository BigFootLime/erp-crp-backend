# Reference-data self-approval on the shared test database

Keenan requested self-approval on `cerp_test`, including its shared use, while
retaining distinct-person approval on `cerp_prod`.

The repository resolves `current_database()` on the same checked-out transaction
that locks and updates the proposal. Only the exact `cerp_test` name permits a
self-decision. Missing or unknown database names fail closed. HTTP headers,
browser state and `NODE_ENV` cannot select the exception. Existing authorization
capabilities, decision reasons, idempotency, optimistic snapshots, immutable
versions and audit logs remain enforced.

The test-only patch leaves the production constraint untouched and adds an exact
database-name condition to the test constraint. A test backup is required before
applying it. The guarded rollback refuses to remove legitimate self-approval
evidence; it never edits or deletes historical decisions.

Verification: run the reference-data repository, policy and authorization tests,
the build, and the migration support checks. Exercise a test self-approval and
verify its audit, then confirm the production database still has its original
actor-separation constraint. The unit tests cover production, unknown databases,
the exact shared test database and ordinary distinct-user production approval.
