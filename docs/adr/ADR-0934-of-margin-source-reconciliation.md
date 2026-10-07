# OF margin sources: partial consumption and revision ownership

WP-278 / backend issue #934.

The former material query used `stock_reservations.consumed_stock_movement_id`
and required a CONSUMED reservation. That pointer is overwritten by each partial
issue; a correction can restore ACTIVE status. It cannot represent physical cost
history. The replacement joins the immutable `of_material_consumptions` ledger
to its exact movement line, article and lot. Each partial or direct OF issue is
included once. Compensated originals, compensating entries and a posted reversal
are excluded. No historical consumption is backfilled or inferred from a
reservation. An unavailable valuation stays missing. An OF issue without a
canonical consumption record produces an explicit missing-proof input, including
untracked consumables; it cannot disappear behind another priced issue.

STANDARD and planned-hour measurements use only the active OF revision (legacy
null revision remains supported). ACTUAL keeps real time on historical revisions,
because the versioning command leaves pointages on their original operation and
copies only planned time. UPDATED combines the active max(planned, real) with
spent time on historical or cancelled operations. A missing applied rate is a
null source row, not a silently omitted operation.

An operation cost based on an applied hourly rate remains ESTIMATED. A received
supplier service or posted stock-line unit cost is DECLARED valuation. Their
physical event is evidence, but it does not verify accounting cost or certify
CUMP. The old source-name substring heuristic must not promote a calculation to
ACTUAL reliability. Supplier flat/minimum charges are already stored in the order
line's `frais_ht`; receipt cost allocates those charges proportionally. A service
priced only by a flat fee is supported. Currency comes from the order/stock line;
the EUR margin engine rejects unsupported or unknown currencies without implicit
conversion. It publishes the known EUR subtotal and explicit missing inputs.

No API fields, financial permissions, formula version or schema are changed.
Old append-only margin snapshots remain historical evidence. Current calculations
use the corrected sources. Rollback is the previous backend artifact; no data
rollback is required.

Remaining audited work: quote cost capture must freeze the actual quote costing
context (never reconstruct it from today's PT), component/consumable allocations,
valuation rules and reconciliation with supplier invoices. Those inputs may not
be replaced with guessed zero costs or rates. `good_quantity` is still the sum of
declarations across operations, not a delivered or saleable finished-piece KPI.

## Combined final recipe (prepared; not executed in this increment)

- Issue a reservation in several partial debits: every issue appears even while
  the reservation remains ACTIVE.
- Compensate and replace one debit: the original and inverse do not add cost;
  remaining valid issues and the replacement still appear once.
- Direct OF issue: use the exact ledger line, without attributing other OF lines.
- Create a new revision after measured time: planned hours use the active revision;
  ACTUAL and UPDATED retain old measured time without old planned-time duplication.
- Unknown rate alongside priced operations: total margin remains incomplete.
- Flat-only supplier service: receipt has its documented proportional fee.
- Unknown unit cost or non-EUR source: missing evidence remains visible and no
  currency conversion or CUMP claim is fabricated.

Immediate verification is limited to TypeScript/build and compiling the real
SQL with PREPARE/EXPLAIN in a READ ONLY transaction ending in ROLLBACK. Business
regression tests and combined acceptance are deferred until all changes finish,
as explicitly requested by Keenan.
