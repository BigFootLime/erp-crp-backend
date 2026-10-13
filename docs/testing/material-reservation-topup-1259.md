# Material reservation top-ups — #1259

The normal Test UI proposed the correct 11 mm increment on a 1,000 mm physical bar already holding 210 mm for the same material need. Confirmation failed with PostgreSQL `23505` on `stock_reservations_active_need_lot_uq`: creation attempted a second active need/lot reservation. The earlier mocked confirmation tests did not execute the canonical SQL/index or the physical hold primary key.

Canonical stock creation now includes `material_need_id` in the original insert. Under the existing lot, quality and stock locks, a conflict on the active material need/article/location/lot identity extends that reservation only when its source and stock batch still match and it has not expired. Its expiry, consumed quantity, original identity and existing evidence remain intact. The stock counters increase only by the requested increment. Ordinary legacy reservations retain their separate unique index.

The physical allocation extends the existing `(bar_id, reservation_id)` row. Its event records both the added length and the resulting total. Bar version checks, quality controls and deferred capacity/canonical-total constraints remain enabled. Failed changes roll back together; command receipts retain idempotent replay.

`scripts/tests/material-topup-1259.repository.cjs` requires the explicit isolated database `material_topup_1259`, an owned restored Test snapshot containing the fictive recipe OF95, and `MATERIAL_TOPUP_COMPILED_ROOT` pointing at the exact compiled backend. It calls the complete material confirmation and canonical stock repositories without replacing their queries, audit/outbox transactions, physical allocations or PostgreSQL constraints. It checks the original reservation/bar identities, the 210 → 221 mm increment, complete 20-blank coverage, replay, simultaneous identical requests, altered-payload replay, another OF and expiry. Only aggregate pass labels are printed.

This database must never be a service target. The administration harness creates it only when absent and removes only that literal database created by its own run. The source Test and Prod databases are not written by these checks. Private snapshot data and runtime dependencies stay outside Git.

The regression script is repository-level evidence. Production/Test deployment and successful confirmation from the normal ERP interface are separate required steps; the 12-scenario recipe and physical label printing remain open.
