# Version purchase copy — #1067

WP-285 Test recipe RF261009 found that preparing an internal technical revision copied purchase references and unit prices but omitted their dimensions, cutting coefficient, price basis, VAT and stored totals. A material purchase and a nitruration service consequently displayed zero totals in the new draft.

`repoCreateNextVersion` now uses `COPY_VERSION_PURCHASES_SQL` to preserve every purchase definition field. PostgreSQL generates fresh row identities and timestamps, and the query assigns only the target version. Its source scope, transaction, permissions and audit stay unchanged. There is no migration or historical recalculation. Drafts created before this correction are not silently repaired.

The PostgreSQL 17 fixture in `src/__tests__/fixtures/version-purchases-copy-1067.sql` requires the isolated database `purchasecopy1067`. Supply `query_file` containing `PREPARE copy_purchases(uuid,uuid,uuid) AS` followed by the exact runtime SQL and a terminating semicolon. Run with `psql -X -v ON_ERROR_STOP=1 -v query_file=/work/query.sql -f /work/version-purchases-copy-1067.sql` inside an isolated, disposable PostgreSQL container.

It compares all business fields in both directions for material at 0.025 per mm, treatment at 4 per piece, a real zero price and null values. It verifies that another version/piece is excluded, original rows stay unchanged, and new row identities are created. The old query must fail with `purchase_clone_business_values_changed`; the new query must pass. The existing assembly/version tests still exercise repository transaction and audit behavior.

Release validation and UI replay are recorded separately in the recipe journal. Full production/receipt/stock/delivery/invoice acceptance remains in progress.
