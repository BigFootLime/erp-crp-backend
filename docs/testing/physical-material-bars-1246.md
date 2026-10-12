# Physical material bars — #1246

Status: domain and additive schema foundation only. Not connected to ERP routes,
receipts, reservations or cutting yet. Do not merge/deploy this migration on its
own: the new deferred checks require atomic updates from all participating stock
commands once a bar inventory has been confirmed.

## Observed problem and scope

The OF95 recipe found 2,000 mm + 210 mm reserved for twenty 110.5 mm blanks:
only nineteen whole blanks were possible. #1244 corrects coverage by stock batch.
A stock batch still represents a lot at a location, not necessarily one physical
bar. Two separate 200 mm remnants of that same batch yield two 110.5 mm blanks,
not three. Conversely, two accounting reservations on one physical bar can
combine into a whole blank. Aggregate stock cannot establish that geometry.

This patch adds an independent identity, measured remainder and version for each
physical bar, linked to canonical stock and canonical reservations. It does not
replace the stock ledger, create a second stock quantity, infer historical bar
lengths, or modify material-origin rules (two origins normally, one for critical
pieces). The inventory movement counter is reserved for freshness checks in the
repository integration; it is not automatically maintained by this foundation.

The domain proposes the missing length on the correct physical bar, preserves
other OF reservations, keeps FIFO between untouched bars, and refuses fictitious
joins between separate remnants. Closing a bar includes its full discarded
remainder; above 150 mm it requires acknowledgement and remains possible.

## Verification performed on 12 October 2026

- 25 Vitest assertions in `src/module/stock/domain/material-bars.test.ts` pass.
- PostgreSQL 17, isolated database `material_bars_1246`: 13 invalid writes rejected,
  one atomic debit preserving the other OF's hold, and one migration replay /
  refused populated rollback retaining bar history (15 explicit PASS notices).
- Empty rollback succeeds. The isolated fixture database was removed afterward.
- No ERP database, stock or real manufacturing operation was changed.

The SQL fixture uses minimal versions of canonical tables, not a production
snapshot. It verifies SQL syntax, ownership, constraints and transaction behavior;
it does not prove full-schema integration or concurrent application commands.

## Reproduce

Run `npm run test:run -- src/module/stock/domain/material-bars.test.ts`.
For SQL, create a fresh disposable database named **material_bars_1246** on a
dedicated PostgreSQL test instance where role `cerp_app` already exists. As the
migration owner, use `psql -X -v ON_ERROR_STOP=1` for each file, in this order:

1. `scripts/tests/material-bars-1246.fixture.sql`
2. `db/patches/20261012_physical_material_bars_1246.sql`
3. `db/patches/support/20261012_physical_material_bars_1246.verify.sql`
4. `db/patches/support/20261012_physical_material_bars_1246.rollback.sql`
5. The migration again, then `scripts/tests/material-bars-1246.assertions.sql`.
6. The migration and verification again: idempotent replay must retain three bars,
   a 900 mm remainder on `fixture_id_1246('bar-1')` and one immutable cut event.
7. Rollback must now fail with `Physical bar history exists`; those records must
   remain unchanged. Remove only the disposable database once done.

## Integration still required before delivery

1. Repository: lock canonical stock/reservations in their established order;
   reconcile measured geometry and movement counters; reject stale identities.
2. Receipt/inventory: propose known article/supplier purchase lengths (e.g. 3 m),
   confirm actual physical bars and reconcile pre-existing allocations explicitly.
3. OF preparation/grouping: use physical yield and existing origin/quality rules;
   prepare only missing purchases; retain material confirmations upstream.
4. Reservation, debit, cancellation, compensation and movement: update canonical
   stock, bar holds, remainder/version and immutable event in the same transaction,
   with command idempotency and concurrency coverage. No bypass via legacy routes.
5. Web/tablet UI: scan or select the bar, prefill known values and display remaining
   length with CERP components. No machine selection for the dedicated cutting app.
6. Replay the real recipe on Test; integrate dev then main and deploy Test/Prod
   only after that proof. Native APK/Electron qualification remains separate.
