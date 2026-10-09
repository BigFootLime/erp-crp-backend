# Complete backend acceptance fixtures (#1059)

The immutable full run at `61df0260` collected 573 files: 538 passed, 15 failed,
20 skipped; 6153 assertions passed and 14 failed. The same 15 failures reproduced
on the unchanged `ab285b93` dev baseline, with the affected files identical.

Seven CUMP/manufacturing files used `node:test` inside the canonical Vitest
collection. Register those tests with Vitest and restore spies after each adapter
test. Keep their assertions and retain the separate requirement for real
PostgreSQL transaction acceptance.

Update existing fixtures to model orders with no forecast conversion, no contract
call and no historical association explicitly; provide stable same-client BL
source identity under the shared advisory lock; declare receipt lane tables
installed when testing subsequent status/quantity gates. Keep original rejection,
no-double-reservation and quarantine assertions.

OpenAPI assertions include the additional scopes on precisely the five assembly
terminal operations. Margin source assertions follow the canonical CUMP adapter,
while retaining the physical consumption, supplier and declaration checks.

No runtime source, authorization, SQL or migration is changed by this test repair.
Targeted replay: 15 files / 149 assertions passed. The full frozen collection is
required again before merge. End-to-end business, database, web and native
acceptance remains tracked in WP-285 and must not be inferred from mocked tests.
