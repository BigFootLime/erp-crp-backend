# Independent business-code counters (#1423)

Creating 12 machines consumed the first 12 values of the shared allocator, so
the first client in the shared Test database received CLI-013. The scope passed
by the application was validated but did not select a separate sequence.

`20261023_independent_business_code_counters_1423.sql` selects a native sequence
by the normalized, strictly validated scope. CLI, FOU, MCH, MET, FIN, each article
family, and every document prefix/year have distinct sequences. Existing native
delivery, reception, stock and accounting counters remain independent.

The migration locks the affected tables, seeds each scope from its own persisted
references (including archived rows), and retains the old shared sequence for
recovery. It never renumbers existing business records. Reapplying cannot lower
an initialized counter. CLI allocation stops at 999, never wraps, and skips
occupied slots. The pre-existing internal-company CLI-999 is reserved without
exhausting the lower unused client slots.

Persisted article families and this/next year's document scopes are initialized
up front. Native `nextval` on an initialized sequence does not roll back when a
creation fails. A first-time, previously unknown scope is initialized under an
advisory transaction lock; creation of that new sequence follows PostgreSQL DDL
transaction semantics until committed. No existing sequence is reset on retry.

Deployment was explicitly authorized by Keenan without a further test campaign.
Before execution, full custom-format backups of cerp_test and cerp_prod were
created and their pg_restore catalogues checked. Both live databases received
the migration. Read-only inspection confirmed distinct sequences, the retired
shared allocation path, CLI maximum 999, and preserved machine counters.

An explicitly authorized operational repair changed the single newly created
Test client from CLI-013 to CLI-001, retaining its primary key, contacts and other
data. Precondition checks required that CLI-001 was unused and no derived quote,
order, invoice, delivery, affair or technical-piece references existed. The repair
was atomic with the migration and recorded separately from authenticated user
actions. No client data or credentials are stored in this repository.

The support verification script is read-only and does not consume numbers. A
rollback must preserve all values allocated since cutover; do not restore a dump
over business activity or reset any sequence. Keep the old allocator definition
and backups in the private server release directory for a reviewed recovery.
