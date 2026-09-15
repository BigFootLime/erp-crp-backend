# External operation flow — backend #717, frontend #967/#968

The additive migration `20260915_subcontract_operation_flow_968.sql` links the
existing `production_transfer_batches` ledger to `reception_subcontract_origins`.
Custody, receipt, Quality, cutting and stock retain their canonical ledgers.
No return is inferred or backfilled, and WIP transfers create no stock movement.

Authenticated subcontract access protects `GET /creation-options`, `GET /:id/flow`
and `POST /:id/transfers` under `/api/v1/subcontract-work-packages`.
The transfer body contains `return_id` (the projected receipt-origin ID),
`successor_operation_id`, integer `quantity`, `expected_version`, `reason`, and
`action` (`RELEASE` or `RETURN`). `Idempotency-Key` is required. Replays retain the
original result; changed quantities or versions require rereading the flow.

Transfers lock planning revision, package, OF, receipt origin and lot before
rechecking Quality and the active route. The release ceiling accounts for other
origins sharing the receipt and for posted stock receipts. Downstream quantities
use effective transfers capped by current Quality. A transfer correction is refused
after downstream start or any quantity declaration. SQL guards prevent over-issue,
cross-OF transfers, source mutation and combined physical over-allocation.

Supplier resources use `subcontract_supplier_calendars`, or the unique active
calendar. They do not reserve a machine/poste slot. Explicit external commitments
use `planning_tasks.committed_start/end`; `planning_events` retains its existing
machine/poste contract. Supplier promises retain line/order provenance, are interpreted
as civil days, and overdue dates cause an issue. An estimate uses five working days
after departure. Partial availability never implies completion of the full quantity.

Planning invalidation includes custody, receipt origins and supplier calendars.
The durable forecast worker only changes forecast columns. Human-approved simulation
application remains transactional and checks revision, actual starts, locks and AR.
The functional rollback setting `subcontract.flow_enabled=false` suspends new transfer
commands while retaining all quantity guards; do not downgrade to a backend that
ignores these transfers once they have been used.

Validation: 50 focused domain tests, 18 tests on a fully migrated isolated PostgreSQL
database, stock transaction regression tests, TypeScript/build and OpenAPI. The general
backend suite initially had only four strict-mock failures in the modified receipt
transaction suite; all five tests in that suite pass after updating its schema probe.
Frontend evidence and remaining human recipe are in
`crp-systems-web/docs/planning/external-operation-flow.md`.

Dedicated PostgreSQL invocation (never use a shared or production database):
`CERP_EXTERNAL_FLOW_PG_TEST=1 DATABASE_URL=postgresql://postgres@127.0.0.1:62168/cerp_test`
with Vitest file `src/module/receptions/repository/receipt-processing.postgres.test.ts`.
The isolation bootstrap applies the complete migration chain. This test uses synthetic
fixtures, not production records and not an automated replacement for the manual P10 recipe.
