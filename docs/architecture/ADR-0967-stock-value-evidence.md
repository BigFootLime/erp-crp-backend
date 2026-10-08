# ADR-0967 — Recorded movement values and CUMP

The CUMP decision accepted by Keenan Martin in ADR-0061 remains the target.
The stock intelligence reader does not maintain that ledger: it reads movement
line prices and previously called the latest weighted line price a CUMP.

The reader now identifies an estimated value at the last recorded movement
cost. Cost, currency, compatibility and movement identity come from the same
latest row, including an unpriced row. It never skips a missing latest price to
borrow an older known price. Each priced movement requires nonnegative prices,
one explicit currency, matching article/stock units and line quantities matching
the movement. Unknown units on any line invalidate the value. Incoherent stock
quantities or mixed currencies remain unavailable, rather than yielding zero or
a negative asset. A known zero price remains a valid recorded declaration.
An ambiguous latest effective timestamp cannot establish posting order from
UUID sorting. ABC does not compare values in different currencies, and missing
outgoing values make the remaining classifications partial.

The ABC uses recorded outgoing values and stays estimated when calculable.
No ERP valuation setting is cited as calculation evidence. Permission denials
do not expose costs or movement identities. Contracts and stock history remain
unchanged; no migration or historical repricing is performed.

Build and a read-only PostgreSQL PREPARE/EXPLAIN check precede integration.
Domain and temporary-table SQL fixtures are prepared for the final combined
acceptance requested by the human, not executed during this lot. The immutable
transactional CUMP ledger, unknown opening cost evidence and receipt/return
valuation remain required work in the parent objective.
