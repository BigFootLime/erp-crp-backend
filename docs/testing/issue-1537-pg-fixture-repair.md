# Issue 1537 PostgreSQL fixture repair

## Changelog

- The stock/delivery PostgreSQL fixture now defines the current receipt, quality,
  fulfillment, Finance lock, traceability, intercompany, recovery, and component
  boundary dependencies used by the repositories under test.
- A newly produced OF lot is received in `QUARANTAINE`; a validated quality
  control plus a resolved non-conformity then releases the original receipt for
  its real reservation reconciliation.
- The receipt scenario asserts the public `repoGetCommandeStockReceipts`
  projection: OF output, stocked quantity, active reservation, expected order
  quantity, and the actual generated lot identity. It deliberately does not
  treat legacy allocation counters as a second production projection.

## Qualification

The disposable PostgreSQL qualification is recorded in
`docs/testing/evidence/issue-1537-pg-fixture-qualification.json`. It records
the tested base SHA, commands, exact test counts, raw report locations, and the
no-deployment boundary.
