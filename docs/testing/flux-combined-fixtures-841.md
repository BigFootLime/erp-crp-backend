# Combined flow verification: backend fixture repairs (#841)

The first L1–L7 combined backend campaign ran 522 files: 5,889 tests passed,
15 failed in eight files, and 91 conditional tests were skipped. The original
failure report remains part of the audit evidence; it is not a successful
acceptance result.

The failing mocks had not been updated for three deployed contracts:

- Revision cloning uses the canonical version projection and a source row lock.
- Order analysis allocates one physical stock pool across compatible revisions.
  SQL returns `compatible_version_ids`, including the source revision. Two route
  tests omitted that array and caused their mocked requests to return HTTP 500.
- Material receipts and reconciled coverage now check need ownership, OF
  criticality, held lots, and root material origins before reserving stock.

The shared SQL fixture declares ordinary OF ownership explicitly and returns
only those owners. The real material-origin policy still executes. Unknown
queries continue to the individual test fixtures; no production guard is mocked
out. Shipment SQL expectations retain the priority of OLD origin and the
reservation/lot/warehouse scope fallback.

No production code, expected HTTP outcomes, quantity assertions, rollback
assertions, or concurrency protections were changed. Targeted validation:
65 tests passed across the eight repaired files; TypeScript `--noEmit` passed.
The complete campaign and business acceptance R01–R26 remain pending until
their separate reports establish the result. Tracked in Project Office WP272.
