# ADR-1123 — Recover the remaining delivery reservation

Status: accepted within the authorized flow audit. Project Office WP-285/WP-286, OBS068; backend issue1123.

Cancelling an unshipped BL releases its reservation. The delivery allocation remains the business identity and must have a guided way to reserve stock again. Relaunching the order is intentionally idempotent and cannot be used to create a second affair or OF.

An authenticated delivery read previews actual remaining demand on the existing allocation. Confirmation requires the existing allocation capability, a stock command idempotency key and the exact preview hash. The canonical receipt-to-delivery reservation writer is reused, with an explicit recovery reason and no fictitious production receipt or OF. Released and consumed reservations, cancelled BLs, initial AR dates and historic OLD references remain immutable.

Only eligible FREE physical stock is offered. Unassigned legacy zones remain available while lane routing is CONFIGURING; DELIVERY and ASSEMBLY zones are always excluded. Urgent borrowing uses its separate planner-controlled replenishment flow. Stock belongs to the same article/technical client. NEW requires the existing quality entitlement and compatible technical version; OLD retains its explicit historical scope and documentary evidence.

FIFO planning caps shared stock levels and shared lot quality quantities. Confirmation locks topology, lot/quality, line/allocation and stock in the existing writer order, then recomputes the preview. Concurrent changes cause a recoverable409, never silent overbooking. Mutation, audit, idempotency receipt and realtime invalidation commit together. No stock OUT, OF, affair, AR or email is created. A shortage leads to the existing production affair rather than another free-text or duplicate launch path.

Validation: pure arithmetic and strict request tests; isolated PostgreSQL recovery, cancellation history, replay, stale preview, concurrency, quality, lane and client refusal; compiled OpenAPI and actual Test UI replay. A passing isolated test is not a completed industrial recipe.
