# Directory session availability (#1341)

Concurrent web tabs and native windows validate the shared directory for every authenticated request. Re-projecting an unchanged identity took a per-profile advisory lock and multiple database round trips. A database lock timeout during projection was incorrectly converted to HTTP 401, which made clients discard a valid session.

The incident fix preserves live authority validation. An identical local profile, its role assignments, work-profile binding and MFA/session projection can use one database read; any difference retains the existing locked reconciliation. Company snapshots remain live, with the revision checked before projecting unchanged creators. A heartbeat extends only its own unexpired presence lease; recovery and state transitions retain the existing per-user lock.

Only explicitly rejected or stale directory sessions return HTTP 401. Database, protocol and server-call failures return HTTP 503 without admitting the protected operation. Failure logs contain a bounded reason, with no token, raw SQL or personal profile.

This patch needs no schema migration, permission change or desktop/mobile installer. It is separate from the complete ISO/GDPR remediation. Validate on the exact production dependency lock and candidate commit: authentication failures and genuine revocations, profile equality and changed assurance, company revisions, presence recovery, strict build and isolated browser navigation. A SQL syntax/type check in a read-only transaction may complement these tests; it does not replace them.

Promote the qualified commit through `dev` and a release PR to `main`. Record the immutable image and previous digest, current recovery evidence and health versions. Observe Test before Production, then verify real request latency and authentication failures. Keep the previous image/release available for rollback; reverting this code requires no database restore.

Qualification on 2026-10-15 with the unchanged production dependency lock (Vitest 3.2.7): strict build and OpenAPI contract pass (1,526 operations); the complete backend suite passes 8,206 tests, with zero failures and 254 pre-existing integration cases pending. The new projection SELECT also passes a read-only PostgreSQL syntax/type check; its `bigint` epoch is returned as a string and is compared only after safe-integer validation. These results qualify this scoped server patch, not the complete audit or a new installer.
