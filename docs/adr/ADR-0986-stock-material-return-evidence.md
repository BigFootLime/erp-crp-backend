# ADR-0986 — Stock material returns and net allocation evidence

Status: implemented, projector remains **PREPARED**. Business and concurrency
acceptance is deferred to the final combined recipe requested by the user.
Issue: #986. Parent: #977 / Project Office WP278.

Material remnant receipts have no new supplier price: they return part of the
exact original Stock issue. Correcting a debit first reverses its remnants and
then restores its original issues. Counting gross returned quantities would
incorrectly reject that complete correction. Partial returns cancelled out of
order also retain different twelve-decimal rounding residuals.

Stock captures remnant → debit/reservation → original movement evidence after
its immutable journal insert, inside the posting transaction. This freezes the
source registry, owner, article, unit and quantities. Missing older links stay
unknown; today's mutable lots and reservations never reconstruct financial
history. Existing explicit `reversal_of_id` links continue to use the original
journal entry. A remnant with an invalid source never falls back to a purchase
price. Client-owned stock remains in its own scope.

The projector plans every allocation before writing. Each return allocates
against its exact original entry; if that original has return allocation events,
the new posting inverts all their effects. This handles a return, its reversal
and subsequent reversals without losing ancestor effects. A bounded immutable
event list (64 ancestors) avoids unbounded work. Beyond the bound, cost remains
unknown with a diagnostic. Per-original cursors hold net quantity/value and
point to their latest immutable event. Cancellation releases the exact recorded
amount; later allocation uses remaining value/quantity with a final residual.

Database guards enforce cursor chaining, immutable amounts, original quantity
and value caps, exact scope, and cumulative inversion limits. Deferred links
require every event to match the new committed valuation entry and its proof
list. Ledger, balance and global projection cursor commit together. The internal
projector retains its advisory lock and journal barrier; it does not lock or
modify physical stock. The adjustment parser follows the real physical contract:
a signed header and positive line quantity with explicit `IN`/`OUT` direction.

The additive migration requires the empty, inactive #983 projector. It adds a
capture boundary and does not backfill older remnant provenance. The worker does
nothing financially while PREPARED. Rollback is allowed only when no proof or
valuation exists; otherwise retain compatible tables or restore the verified
pre-deployment backup. No cost activation, manufacturing-output valuation,
invoice correction or reliable margin publication is implied by this release.
