# Physical material bars — #1246

Status: domain, additive schema, inventory API, canonical reservation creation /
release, OF proposals, planning/start coverage, measured debit and correction are
implemented, along with normal grouping and its exact dissolution and standard
material receipts. The general movement domain and transactional adapter are
connected to posting, with explicit receipt/debit/correction ownership. General
compensations, stocktaking and web/tablet screens still need their full workflow.
Do not merge/deploy this branch yet: the deferred checks require
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
transaction; standard receipts append actual bars in that transaction too.
General posting now invokes the movement adapter below; remaining legacy paths
are protected by a deferred consistency check, pending their complete workflow.

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

## Grouping and exact restitution

Normal grouping combines all source OF reservations before calculating surplus.
Its shared per-bar budget prevents two material needs from proposing the same
free length. Canonical surplus reservations receive the selected bar IDs/lengths;
their versions are reread between needs under the existing stock locks.

Ownership transfer records immutable TRANSFER events, zeroes the original holds
and adds their exact bar lengths to the producer hold. Physical quantities and
stock movement counters do not change. Dissolution reads these proofs before any
canonical mutation, restores the original bar/source pairs and releases only
surplus. It refuses changed producer allocations even if their aggregate quantity
is unchanged. An unrelated OF can change its own holds without being overwritten
or unnecessarily preventing restitution. RESTORE events retain the inverse proof.

49 targeted tests pass for the branch's grouping, physical surplus and coverage.
Eight additional PostgreSQL checks exercise the real physical ownership repository:
rollback, same-bar aggregation, recovery extension, altered allocation rejection,
exact restitution after unrelated changes, replay refusal, regrouping restored
sources and surplus-only holds. Canonical ownership is simulated with minimal SQL
in `scripts/tests/material-bar-transfer-1246.repository.cjs`; this remains distinct
from the full ERP grouping transaction and its live business acceptance.

The separate unreleased recovery candidate has also been wired to these helpers
in the combined stage. Its 63 targeted tests pass, including the existing rule
that finished cutting forbids adding recovery work. Those candidate files are
not imported into this branch; their integration/publication remains explicit.

## Received bars and purchase-length proposals

Standard supplier and customer material receipts accept `material_bars` groups
(`lengthMm`, `count`); the reception tablet command accepts the same groups as
`materialBars`. The sum must equal the existing, quality-checked purchase-to-stock
conversion. Bar-to-cut articles in mm require actual geometry. Packaged piece
receipts reject this input rather than silently discard it.

The receipt locks the lot and its reservations before movement creation, appends
new bar identities after canonical IN posting, and only then allocates material
to the OF. These steps share the existing transaction and idempotency receipt.
Existing bars, remnants, versions and holds are preserved. A second application
of the same plan cannot duplicate bars. Existing unconfirmed or inconsistent
stock requires a count or another location; a new receipt never certifies unknown
old stock. Recording physical delivery and subsequent quality control remain
separate from this put-away operation.

Processing details expose `materialBarProposal`: the snapshotted purchase length
takes precedence for purchases by bar; the known article source length is used
for other units converted to mm. For example two purchased 3 m bars propose two
3,000 mm bars even if the article default has since changed. No fractional bar,
arbitrary last remnant or historical geometry is inferred. The receiver must
confirm the suggestion. UI confirmation and scan integration are still pending.

42 targeted tests cover receipt units, strict geometry, defaults, transaction
ordering/rollback and customer ownership. Ten isolated PostgreSQL checks execute
the actual receipt/inventory/reservation repositories: rollback, distinct bars,
immutable IN proofs, replay rejection, immediate reservation, partial receipts,
conversion mismatch, unknown old stock, tracked geometry requirements and stale
stock. The canonical IN posting is simulated by minimal SQL, not the full ERP
quality/receipt schema. Use `material-bar-receipt-1246.fixture.sql` after the base
fixture and migration, then `material-bar-receipt-1246.repository.cjs` with the
temporary connection on stdin. The fixture database/login are removed afterward.

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
2. Receipt geometry and purchase-length proposals are connected on the server;
   finish their web/tablet confirmation screen and full ERP acceptance.
3. OF preparation, planning and normal grouping use physical yield and exact
   ownership transfers. Integrate the separate recovery candidate with these
   helpers and validate the full grouping transaction on the ERP schema.
4. Debit, correction, dissolution and general `repoPostMovement` are connected.
   Explicit ownership avoids double application in managed receipts/debits and
   their corrections. Finish generic stock compensations and stocktaking with
   exact physical measurements/proof, plus SCRAP/DEPRECIATE quality allocations
   that retain physical stock, then verify the entire canonical command
   on the full ERP schema. Deferred guards prevent legacy bypass meanwhile.
5. Web/tablet UI: scan or select the bar, prefill known values and display remaining
   length with CERP components. No machine selection for the dedicated cutting app.
6. Replay the real recipe on Test; integrate dev then main and deploy Test/Prod
   only after that proof. Native APK/Electron qualification remains separate.

## General movement adapter — 12 October 2026

`material-bar-movement.ts` and its strict validator cover actual receipts,
unreserved issues and whole-bar transfers. No guessed 3 m default becomes an
actual bar without confirmation. Three decimal places are retained. Transfer
keeps article, lot, barcode identity, original length and audit history; moving
a reserved bar is refused, while another free bar of the same batch may move.
An issue may consume the free tail without reducing an OF's held length.

`prepareMaterialBarMovementTx` locks the source and destination snapshots;
`applyMaterialBarMovementTx` requires the posted canonical ledger in that same
transaction client. It checks quantities, versions, held stock, movement counts,
and both transfer legs before writing geometry. An OUT+IN pair with zero net
quantity cannot hide behind an unchanged balance. A completed prepared object
cannot replay. The stock command remains responsible for durable idempotency,
quality/RBAC checks, audit context, rollback and commit.

The additive `20261012_physical_material_bar_movements_1246.sql` patch narrowly
allows relocation when immutable MOVE events match the exact original/new bar
versions and both posted canonical legs. All selected lengths must equal the
transfer quantity. It preserves the original identity/initial-length and hold
guards. Its rollback reinstates the old relocation prohibition, without moving
stock back or deleting proof. Apply it after the base physical-bar migration;
run its preflight and verification scripts. Replaying the base patch afterward
restores the stricter old guard, so reapply this patch last.

Verification: 72 targeted domain/receipt/inventory tests and the backend stage
build pass. **19 PostgreSQL checks** execute the real adapter on the isolated
`material_bars_1246` fixture: receipt, positive/negative adjustment, exact 0.001
mm decrement, free-tail issue, reserved-bar rejection, identity-preserving and
multi-bar transfer, rollback, stale state, missing/extra ledger changes, proof
rejection, cross-client refusal and concurrent lock contention. Migration,
verification, rollback and reapplication pass. Temporary database/login removed.

Reproduce with the base fixture/migration, receipt fixture, then
`material-bar-movement-1246.fixture.sql`, new movement patch and
`material-bar-movement-1246.repository.cjs`; credentials go through stdin. These
tests write canonical quantities explicitly on a minimal schema. They **do not
validate `repoPostMovement`, the HTTP path, full ERP ledger triggers or the real
business recipe**. No Test/Prod data or schema was changed by these tests.

## Posting integration — 12 October 2026

`repoPostMovement` now invokes the physical preparer before posting and applies
the geometry before completing its command. Article unit/lot locks are resolved
before stock locks. The strict `material_bars` HTTP field is consumed, never
ignored. Non-bar articles retain their normal posting path.

Managed receipt, reserved debit and its correction use an opaque, single-use
capability created by their own preparer. It is bound to the transaction client,
movement, batch, quantity, direction and original movement for a correction.
The generic path cannot skip tracking merely because it has an external SQL
client. `check_material_bar_stock_1246` defers physical/ledger reconciliation
until commit; an owner that forgets to finish its updates causes full rollback.
Its specific constraint is exposed as an actionable 409 without SQL details.

161 targeted tests pass, covering the new boundary, managed call sites and error
mapping alongside the physical domain. PostgreSQL verification now includes 25
movement/boundary checks and the 9 debit/correction checks with their real owner
capabilities under the new deferred triggers. The fixture still simulates the
canonical ledger. Full `repoPostMovement`/ERP-schema acceptance remains open;
this is not a complete HTTP or business recipe validation.

The actual canonical ledger keeps SCRAP and DEPRECIATE quantities in stock and
reduces availability. ISSUE explicitly rejects those types; treating them as
physical cuts would remove stock twice. Per-bar quality allocation is an open
integration, not silently approximated by a bar-length subtraction.

API contract and remaining stocktaking/compensation/quality gaps:
`docs/http/physical-material-movements-1246.md`. Do not merge/deploy the branch
until those workflows, UI and the real Test recipe are ready.

## Generic compensation — 12 October 2026

The read-only compensation preview checks immutable physical history before an
inverse draft is proposed. Posting derives its plan from the original movement,
under the same lot/reservation/stock locks, with no caller-supplied replacement
bars. OUT/negative adjustments restore the original bar; IN/positive adjustments
retire unused bar identities; transfer inverses retain barcodes and return them
to the original batch. Versions advance and original events remain immutable.
Subsequent physical use, an incomplete proof, duplicate reversal, altered inverse
quantity or held incoming/transferred bar prevents posting. Restoring a free
tail keeps existing OF reservations. A compensation cannot itself be reversed
through this generic path; managed receipt/debit corrections remain separate.

182 targeted tests pass. The PostgreSQL fixture adds 14 compensation checks to
the existing 25 movement and 9 debit/correction checks, including read-only
preview, complete consumption, retirement, transfer return, fractional amounts,
reservations, replay, cross-client misuse and transaction rollback. No new
migration is required by this increment; the fixture adds reversal_of_id already
present in the real ERP schema. These still exercise physical repositories with
simulated canonical ledger writes, not complete ERP HTTP acceptance. Stocktaking,
per-bar quality allocation, UI and full-schema business acceptance remain open.

## Recorded stocktaking — 12 October 2026

Inventory count events now retain immutable measured bar identities, lengths
and reservation allocations. Save only records a measurement; approval checks
its physical version and second-count requirements; close posts canonical
adjustments and updates geometry in one transaction. Equal-total changes still
produce a physical reconciliation without an artificial stock movement. Counts
cover initial untracked stock, shortages, extra bars and explicit hold allocation.
Existing bar initial lengths cannot be enlarged and another batch's barcode
cannot be reused. A stale physical snapshot cannot close even if its total is
unchanged. The read model returns the recorded measurement.

Migration dependencies enforce bars → movements → counts. The additive count
table binds evidence to its open canonical count, batch and quantity, prevents
rewrite/deletion, and refuses rollback once evidence exists. The broader stock
compatibility suite also exposed an obsolete compensation-preview fixture: the
non-batch/duplicate path now avoids an unnecessary physical transaction, and
two dedicated tests cover successful and refused physical previews.

78 targeted stock/count/route/validator checks pass, plus the focused migration
ordering check. 19 PostgreSQL count checks join the 25 movement, 9 debit/correction
and 14 compensation checks. Migration, verify, rollback and reapplication are
tested on the isolated schema. The repositories are real but canonical ledger
writes are simulated; full ERP inventory-session/HTTP acceptance and visual
web/tablet recipe remain required. No Test/Prod database was changed.

## Per-bar depreciation

The additive quality patch assigns canonical depreciation to specific physical
bars without reducing their remaining length. Reservation proposals, explicit
allocations, ordinary issues and production debit exclude the assigned amount.
Counting preserves the canonical depreciation total, including equal-total
reallocations which require the configured second count. Missing historical
allocations require explicit reconciliation instead of guessing rejected bars.

The canonical posting adapter routes a strict `DEPRECIATE` selection to a private
transaction-bound capability. The existing quality disposition command also
uses this boundary before posting `SCRAP` or a supplier-return `OUT`. Readiness,
ledger effect, bar versions, reservations and movement watermark are checked.
Deferred SQL guards reject mismatches even when a legacy command writes directly.
Known geometry/quality constraints return an actionable 409, not a server error.

The targeted domain/adapter/validator suite contains 150 passing checks; the
quality/stock route and error boundary suite contains 65. PostgreSQL fixtures
cover selected-bar depreciation, remaining usable capacity, replay and wrong
transaction refusal, incorrect ledger rollback, no double depreciation,
immutable history, reservation overlap and retention on rollback. Canonical
fixture ledger writes are simulated; they do not prove complete ERP-schema or
HTTP business acceptance. Build and exact-tree verification are recorded with
the release evidence. Full-schema quality, web/tablet selection, physical
disposal/quality corrections and end-to-end recipe remain required.

Two initial failures were assertions on the existing reservation error wording;
the original message is retained and quality gets its own explanation. An order
test was corrected to assert only required dependencies: counting and quality
both follow movements, with no artificial ordering between these independent
patches. No Test/Prod database was changed during these checks.
