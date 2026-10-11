# Invoice issuance and order synchronization — #1230

An approved invoice failed during issuance with PostgreSQL `42P10`. The error
rolled back the transaction, including its legal number allocation. The same
approved draft can be retried; creating another invoice is unnecessary.

The server log identified `listIssuedInvoiceCommandeIds`. Its `SELECT DISTINCT`
projects `delivery.commande_id::int`, while its `ORDER BY` referenced the
unconverted underlying column. PostgreSQL requires a DISTINCT query's ordering
expression to appear in its output. Ordering by the `commande_id` output alias
uses the converted value and preserves deduplication and stable lock order.

No migration, authorization, business status, allocation, legal-number sequence,
document immutability, or idempotency rule changes.

## Regression verification

Extract the SELECT template from `listIssuedInvoiceCommandeIds`, substitute its
single invoice parameter with `0`, and submit it to PostgreSQL within
`BEGIN READ ONLY`, prefixed by `EXPLAIN (FORMAT JSON)` (without `ANALYZE`). Finish
with `ROLLBACK`. Before the fix this reproduces `42P10`; after the fix it parses
and plans successfully against the same schema without writing business data.
The operator evidence is `finance1230-query-before.json` and
`finance1230-query-after.json` in WP285's audit directory.

Run the existing Finance workflow and order fulfillment regression tests,
including atomic rollback, immutable document cleanup, idempotent replay,
partial invoicing and internal-order exclusion. Compile the exact merged backend
before deployment. Finally retry the existing approved Base Test invoice through
the normal UI and check its PDF, allocations and linked order status. UI acceptance
is recorded separately; this source change alone is not proof of end-to-end success.
