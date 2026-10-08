# ADR-0937 — Consolidated physical material holds

Status: implemented; combined business acceptance remains pending by user instruction.

## Problem

Issue #937: source OFs can reserve the same material lot at the same location. Retargeting both active reservations to one producer need violates `stock_reservations_active_need_lot_uq`. A surplus using the same physical stock has the same collision. Removing uniqueness would allow ambiguous debit and preparation ownership.

## Decision

Keep uniqueness and create one active producer reservation per need/article/location/lot. Reserve only surplus through the canonical stock reservation API, while source commitments still exist. Aggregate source quantities into that producer reservation without charging the stock counters again. Preserve each original source reservation ID, OF, need and quantity; release its logical ownership inside the same transaction.

`production_consolidation_material_holds` records the immutable transferred and surplus quantities for every producer reservation, including surplus-only lots. The existing immutable transfer ledger records the producer reservation and a source quantity snapshot. The producer expiry is the earliest applicable source or surplus expiry. No public API shape changes.

Dissolution locks the OFs, lots, stock counters and reservations. It requires unchanged, unexpired, unconsumed and unprepared reservations, reconciles source snapshots and the producer total, and checks reserved counters. It releases only the surplus and reactivates the exact original source holds. Prepared or changed holds cause a recoverable 409; the transaction cannot leave a partial restoration. Existing quality, same-definition and one/two material-origin policies remain authoritative.

Historical transfer rows keep null new columns and use their existing dissolution path. No historical source quantity is reconstructed from current stock. Ledger records are immutable and retained after dissolution.

## Migration and rollback

Apply `20261008_consolidation_material_holds_937.sql` after #815 and the need-level reservation uniqueness patch. Preflight checks prerequisites; verification checks the table, immutable trigger and constraints. The schema is additive. Before any new-format consolidation exists, the previous binary can be restored while keeping this schema. After new ledger use, use a forward fix or restore the matching predeployment database and release recovery set; an older binary cannot safely dissolve the new ownership representation. The rollback companion explicitly refuses that unsafe combination and never deletes provenance.

## Evidence and acceptance

Strict TypeScript compilation and 19 actual query plans compiled under `cerp_app` with the additive DDL rolled back. No business statement was executed by SQL compilation. Integration cases are prepared for same-location holds with zero/five surplus, preserved batch and level counters, refusal after preparation, exact dissolution and concurrent/idempotent creation. Their execution belongs to the combined final acceptance requested by the user; compilation is not a claim of business acceptance.

Report links: sections 7/9 (schema and provenance), 12 (prepared acceptance), 14/15 (deployment and matching rollback), 16 (issue/PR/proof history).
