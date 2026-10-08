# Stock material returns — final combined recipe

**PREPARED / NOT RUN.** The user requested business/security/concurrency tests
after all development tasks. Build, OpenAPI and SQL/DDL compilation in ROLLBACK
are release checks; they are not business acceptance. Never activate the
projector on Production to run these scenarios.

Use isolated final acceptance fixtures with known zero opening stock and an
explicit purchase receipt. Retain movement, journal, valuation and allocation
event IDs, hashes, scope, quantities and exact amounts. Assert physical stock
separately from its financial ledger.

1. Receive 10 at total value 10; issue all 10 for an OF; return remnant 3. Value
   the remnant from its original issue, not a catalogue/current-average price.
   Freeze its debit/reservation link. A mutable source edit must not alter it.
2. Correct that debit: reverse remnant 3 then restore original issue 10 in one
   transaction. Final Stock quantity/value = 10/10; original issue net return
   cursor = 10/10. The remnant cancellation releases its earlier 3/3 allocation.
3. Original issue quantity 3/value 1: two returns of 1 carry
   0.333333333333 and 0.333333333334. Cancel the first; then return the remaining
   quantity in two parts. Total net quantity/value = 3/1 exactly, with no penny
   or twelve-decimal drift. Include further cancellation of a cancellation.
4. Partially cancel one returned quantity twice. Each partial amount follows
   remaining original amount; reject over-inversion in quantity or value.
5. Use an unknown original amount. All return effects retain unknown value.
   No catalogue, zero, latest purchase price or owner conversion may fill it.
6. Missing pre-boundary original, owner/article/unit mismatch, missing registry,
   changed hash or >64 ancestor events: record unknown cost and diagnostic,
   without any partial allocation cursor update or physical Stock mutation.
7. Negative ADJUSTMENT header with positive OUT line must reverse a remnant;
   opposite or mixed signs are unresolved. Explicit receipt reversal continues
   to use its original acquisition amount, including acquisition fee allocation.
8. Force failure after event insert / cursor update / valuation insert, and
   simulate uncertain COMMIT/retry. Each transaction is all-or-nothing; retry
   from the durable projector cursor creates no duplicate cost or event.
9. Parallel physical posting during a batch, sequence gaps and two projector
   workers: the journal barrier/advisory lock preserve complete root processing.
10. Attempt direct event update/delete/truncate, broken predecessor, fabricated
    original entry or event proof, and inversion beyond original amount. Require
    transaction rejection; never weaken Stock or manufacturing RBAC.

Prepared Vitest fixtures:
`src/module/stock/domain/cump-projection.test.ts`,
`src/module/stock/domain/cump-material-return.test.ts` and
`src/module/stock/repository/cump-return-ledger.test.ts`.
Record actual results at final acceptance; do not mark WP278/#977 complete now.
