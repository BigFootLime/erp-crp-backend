# Subcontract audit — OBS057 / backend1099

The two remaining direct audit INSERTs omitted `event_type`. Actual Test schema
metadata establishes a NOT NULL column with no default. This issue was found by
source inspection after the OLD-reference HTTP500; a live subcontract mutation
has not yet been replayed for OBS057.

`appendSubcontractAudit` delegates to the canonical ACTION writer using the
caller's transaction. Creation, ISSUE, RETURN, finalisation and transfer keep
their existing actor, action, package and details. Audit notification remains
transactional. Quantity, receipt evidence, genealogy, quality, idempotency and
authorization guards are unchanged. No migration is needed.

Run the focused checks:

```sh
node node_modules/vitest/vitest.mjs run src/__tests__/subcontract-audit-1099.test.ts
```

The 12 checks mount the real custody router and exercise the actual transfer
callback and shared audit writer. A SQL fixture rejects any INSERT omitting
event_type with SQLSTATE23502, matching the actual schema. It covers the five
custody actions, ACTION metadata and durable outbox, route rollback on audit or
outbox failure, RELEASE/RETURN transfer details, retained receipt quality gate,
and audit/outbox failures propagated to the planning transaction owner. The
planning ledger and actual PostgreSQL runtime are outside this focused suite.

Before completing OBS057, compile the immutable candidate and replay the
supplier custody/return/quality path on Base Test. Production recipe data must
not be created. A passing focused suite is not full recipe acceptance.
