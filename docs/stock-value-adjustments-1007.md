# Documented current stock value — #1007

The Stock owner appends a financial adjustment to the current company/EUR value. No stock movement, receipt, consumption, reservation or physical quantity changes. Past snapshots and issue costs remain immutable. This is an explicitly documented total current value, not automatic allocation of a late invoice between consumed material and remaining stock.

## Contract and rights

`GET /api/v1/margins/stock-value/:articleId/:unit/candidate` returns an eligible source fingerprint, unchanged company quantity, previous value (possibly null) and up to 100 active article documents. `GET .../adjustments` returns bounded immutable history. `POST .../adjustments` accepts only request UUID, expected candidate SHA, document UUID/SHA and decimal-string total HT. Reads require `margin:read_costs`; writes require `margin:snapshot`, using the existing account-module gate and actor audit context. Responses are no-store. Amounts remain decimal strings with 12 fractional digits; the browser must not derive accounting amounts.

The projector must be ACTIVE, initialized, current formula/EUR, with no captured movement still pending and no unresolved article proof. Current physical LEVEL quantities include BATCH quantities; client-owned usable quantities are subtracted once. Lot, canonical unit, ownership, depreciation, physical sum and latest immutable balance proof must reconcile. The proof is bounded to 10,000 observations and 2 MiB. No catalogue price or guessed missing ownership is allowed.

## Atomicity and immutable history

Request UUID lock precedes the global CUMP lock, control-row update lock and journal SHARE barrier. Rechecking the source/document detects stale forms. The identical UUID/body/actor replays; changed content conflicts. Declaration, financial entry, balance and audit commit together. Deferred entry FK plus the deferred commit guard require the exact adjustment-linked financial entry and updated balance. One correction of a given scope is committed per transaction; the HTTP endpoint creates one correction per transaction. Existing #983 entry/balance/control guards are unchanged. Physical/opening uniqueness remains NULLS NOT DISTINCT with a sixth correction UUID that is null for all earlier entry kinds.

The quantity delta is zero. New current value is DECLARED. With a known previous value, the signed delta is exact and movement value is its absolute value. With an unknown previous value, both deltas remain null and `PREVIOUS_VALUE_UNKNOWN` is retained. A document justifies the whole current amount; it does not manufacture any earlier cost. A later correction appends another entry.

## Delivery and recovery

This migration does **not** activate CUMP: delivery retains PREPARED/uninitialized/sequence zero. A global acceptance gate still precedes activation. Compile schema and actual queries with PREPARE/EXPLAIN in ROLLBACK on both databases; compare original #983 guard function definitions. Before application, require a verified complete backup and separate Test/Prod dumps. Apply the tracked additive patch, verify enabled triggers/metadata/health, then deploy Test and Prod backend plus public artifact. Existing served frontend is preserved for this backend lot.

The supplied rollback refuses any financial declaration or adjustment entry. Use forward recovery if proofs exist. Empty-feature rollback restores earlier entry checks/uniqueness without changing any original guard function. Retain backup, manifest, schema compilation and version/health proofs; do not delete historical accounting data.

## Common acceptance — prepared, NOT RUN

1. PREPARED rejects writes and exposes no eligible amount; no activation occurs while viewing.
2. Read/write roles, denied module access, database and user isolation; no financial proof leaks.
3. Known value 100.000000000001 → 0.000000000001 at unchanged quantity: exact negative delta -100; immutable prior entry.
4. Unknown previous value → documented amount: previous value/delta remain null; future uses DECLARED and historical issue costs stay unknown.
5. Active article proof in EUR only; client quantity excluded once; mixed/missing lot, bad unit, depreciation and level/batch mismatch reject.
6. Any global pending journal, uncaptured posted movement or unresolved article proof blocks approval.
7. Stale physical quantity/previous entry/global cursor and removed/replaced document return conflict without partial writes.
8. Identical request replays exactly; changed body/actor conflicts; concurrent projector, posting and financial adjustments cannot lose updates.
9. Commit without linked entry or balance, with unrelated entry UUID, altered delta/reliability/issues or reused old entry fails atomically.
10. Whole current value may be zero with positive stock; empty stock, negative/overflow/excess precision values reject.
11. Future issue follows the adjusted current value; old return allocations and manufacturing cost snapshots retain their exact earlier bases.
12. Multiple successive corrections maintain full before/after chain; physical posting/opening uniqueness still rejects duplicates.
13. Full backup, Test/Prod migration, restart and routing proofs; empty-feature rollback refuses nonempty history.

Business, RBAC and concurrency scenarios above are deferred to the final combined recipe as requested. Compilation is technical validation only.
