# Fractional technical prices and durations — #1062

The real Test recipe accepted 0.025 EUR/mm, then stored 0.03 while retaining the
original 2.76 EUR line total for 110.5 mm. Its 23-minute operation total came
back as 22.98 minutes. Read-only probes confirmed restrictive PostgreSQL scales.

The additive patch widens the two technical unit-price columns and the total
operation/OF duration columns. Method policy still calculates hours; monetary
totals still use cents. No historical row, cost or frozen technical snapshot is
recomputed. Lost precision cannot be inferred from existing amounts.

The active-execution view depends on OF durations. Its definition, owner,
options, comments and grants are captured and restored in the same transaction.
New default grants are removed before restoring the original permissions.
Column grants, delegated grant chains or dependent views fail explicitly;
no cascading removal occurs.
A short lock timeout bounds lock waiting. An application rollback retains the
wider schema so newly entered decimals are not lost.

The first canonical Test application failed on the existing operation dossier
invalidation trigger's WHEN expression. PostgreSQL rolled back the patch and
the prior Test backend was restarted; Prod was not changed. The un-applied patch
now captures and restores conditional OF triggers in the same transaction,
including their definition, enabled mode and comment. The isolated fixture
includes this dependency and checks that invalidation still executes.

Executed on an isolated PostgreSQL 17 container with no network or production
volume: application and replay PASS; 0.025 and 0.000001 unit prices retained;
23, 1 and 0.5 minute totals and fractional OF times retained; historic values,
view definition/options/comments/owner and SELECT grant option unchanged. New
default grants are not inherited. A dependent view rejects the patch and rolls
back all preceding changes. The rollback check retains the widened schema.
Fixtures are in `db/patches/support/*1062.isolated-*.sql`, guarded by the exact
isolated database name. The disposable container was removed after the checks.

Remaining evidence: canonical migration-runner verify, fresh backup and deployment,
then actual UI resave of the synthetic recipe purchase. Full WP-285 acceptance
remains in progress until that evidence and the business scenarios are complete.

Required evidence: isolated PostgreSQL application/replay, unchanged values and
view permissions, 0.025 price and short-duration round trips, preserved monetary
total scales, canonical migration-runner verify, fresh backup and deployment,
then actual UI resave of the synthetic recipe purchase. Full WP-285 acceptance
remains in progress until that evidence and the business scenarios are complete.
