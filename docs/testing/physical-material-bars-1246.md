# Physical material bars — #1246

Status: domain, additive schema, inventory API, canonical reservation creation /
release, OF proposals, planning/start coverage, measured debit and correction are
implemented. Receipt, grouping and general stock movement integration are still
pending. Do not merge/deploy this branch yet: the deferred checks require
atomic updates from all participating stock commands once an inventory is confirmed.

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
pieces). The inventory movement counter detects untracked stock movements, even
an OUT/IN pair whose net quantity is unchanged. Explicit remeasurement reconciles
it. Debit and correction now maintain geometry and this counter in their stock
transaction; receipt and general stock movements still need the same integration.

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
it does not prove full-schema integration.

The next integration adds 15 real PostgreSQL repository checks: inventory reads,
initialization, remeasurement, unchanged canonical quantities, preservation of
retired identities, stale version rejection, net-zero movement detection, two
concurrent confirmations, reservation on two bars, release, and rollback of the
canonical reservation after a stale bar write. The database and generated
temporary test login are removed afterward. No existing password is read.

98 targeted Vitest tests pass; the stock route suite then passes again with four
new API tests (15 route tests in total). The new cases verify read/write rights,
strict input rejection before mutation, authenticated actor and replay status.

## Inventory API and reservation integration

- `GET /api/v1/stock/material-bars/batches/:batchId`: stock read capability;
  returns bar lengths, holds, canonical reservations, review state and version.
- `PUT` on the same path: inventory approval capability, optimistic version,
  UUID idempotency key and measured bars. The sum must equal canonical stock and
  each allocation must match its reservation. This operation cannot change stock
  quantities, release quality, or invent historical geometry.
- A bar cannot grow beyond its recorded initial length; correcting an erroneous
  identity retires it and records a new bar, preserving its history.
- Canonical reservation creation optionally accepts `barAllocations` (bar ID,
  quantity in mm and expected version). Without a selection it assigns available
  lengths in FIFO order. Whole-blank OF coverage must supply its forthcoming
  physical yield proposal; generic length allocation alone does not prove yield.
- Canonical release removes holds on those same bars, leaving physical lengths
  and other reservations intact. Generic consumption of tracked bars requires
  the cutting path, which records canonical stock and physical geometry atomically.

## OF coverage integration

This branch incorporates #1244's batch-level correction as a dependency, then
replaces its aggregate bar assumption with measured geometry. The OF preview bulk
loads canonical balances, bars, holds and movement versions in five queries for
all relevant batches. Its optimistic fingerprint includes geometry changes.
Unknown or stale geometry contributes no usable held capacity. If compatible
stock exists but its shape needs review, purchase preparation remains incomplete
instead of silently buying that stock again.

Whole-blank proposals complete existing partial holds on their own bar first,
with the smallest top-ups first when quality/location availability is limited.
Full blanks then follow FIFO. Shared preview budgets prevent another need from
claiming the same free length. Actual confirmation derives per-bar allocations
server-side and sends their versions to the canonical reservation command. It
re-reads those versions between needs sharing a bar inside the transaction.
Planning and operation-start checks reuse the same physical held capacity, while
retaining quality eligibility and the maximum of two material origins (one for
critical parts). Bar count does not become an origin count.

110 targeted tests pass, including physical coverage, legacy/unit stock, quality,
origin limits, separate remnants, limited shared budgets, confirmation and the
existing debit regression suite. The PostgreSQL repository exercise now has 18
checks: the added checks verify bulk reads, an actual 31.5 mm top-up across two
bars, and movement invalidation of both preview and readiness. These remain
isolated minimal-schema tests, not the full ERP recipe.

## Measured debit and correction

A BAR debit identifies the physical bars, their expected versions and the cut
length on each reservation. Several accounting holds on the same physical bar
can fund one blank; separate physical bars cannot be joined by summing lengths.
Observed good/scrap yield is entered per bar when several bars are selected and
must reconcile with the operation totals. Stock quantities remain in millimetres;
produced blanks remain in units. Legacy unit and sheet debit contracts stay valid.

The production owner locks all source lots, prepares the physical cuts, posts the
canonical stock consumptions, then updates lengths, holds, versions and immutable
CUT proofs before declaring WIP. Any downstream failure rolls the transaction
back. Closing a bar records the exact discarded remainder, with acknowledgement
above 150 mm. Its temporary reservation extension can use only the free length
of that bar, preserving the same OF's unused holds on other bars.

A correction first proves that the cut is still the latest bar version and that
its holds and movement proofs still match. It then restores canonical stock and
the exact former holds/length, increments the bar version and appends COMPENSATE
history. It refuses restoration after later use, reservation or remeasurement;
no historical proof is overwritten. Debit history exposes these bar events.

94 targeted Vitest tests pass for debit, request validation, observed yields,
canonical consumption, correction, coverage and quality. The backend stage build
passes. PostgreSQL 17 replays the existing 18 repository checks plus 9 new checks
using the real physical debit/correction repositories. These cover shared holds,
rollback, later-bar-change rejection, exact correction, double compensation and
closure preserving another bar's hold. The fixture simulates canonical postings
with minimal real SQL: it does not execute the full ERP stock, quality or WIP
commands. Unit tests cover that production orchestration separately. Temporary
database and generated login are removed afterward; no ERP stock is changed.

The repository exercises are `scripts/tests/material-bars-1246.repository.cjs`
and `scripts/tests/material-bar-debit-1246.repository.cjs`. Both refuse any database
except the isolated `material_bars_1246` fixture and read its connection on stdin.

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

1. Inventory repository and canonical reservation creation/release are connected;
   finish the remaining stock command integrations listed below.
2. Receipt/inventory: propose known article/supplier purchase lengths (e.g. 3 m),
   confirm actual physical bars and reconcile pre-existing allocations explicitly.
3. OF preparation and planning now use physical yield; grouping still needs exact
   per-bar hold transfers and restoration under the existing origin/quality rules.
4. Debit and its correction are connected. Consolidation, recovery and general
   movements still need atomic canonical stock / bar hold updates and immutable
   history, with idempotency and concurrency coverage. No bypass via legacy routes.
5. Web/tablet UI: scan or select the bar, prefill known values and display remaining
   length with CERP components. No machine selection for the dedicated cutting app.
6. Replay the real recipe on Test; integrate dev then main and deploy Test/Prod
   only after that proof. Native APK/Electron qualification remains separate.
