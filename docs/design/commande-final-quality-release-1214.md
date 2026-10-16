# Final quality coverage for delivery

Issue #1214, WP 287. Command delivery accepts validated FINAL controls on completed operations belonging to each OF, or RECHECK/LOT_RELEASE controls on its actual produced lots. Output quantities cap lot coverage. Independent operation and lot channels use the maximum rather than addition, preventing duplicate checks from releasing an incomplete population. Raw-material lots and controls of another OF do not qualify. Open non-conformities still block. No schema or authentication change.

Validation: 12 fulfillment regression tests, strict build, actual PostgreSQL read-only S03 query returns 3 active OF, 0 unreleased, 0 open NC. Normal UI BL/invoice replay remains required.

## Historical OLD lots in V2 shipment

A V2 shipment continues to require the signed delivery-quality aggregate before any stock movement. For an OLD lot with no current CERP control ledger, the operational lot gate is omitted only when every exact allocation in the physical group is represented by the aggregate as OLD, has no controls, has no current lot control, and carries a server-side historical document reference. Missing allocation metadata, a current control, NEW provenance, or missing evidence keeps the operational gate in force.

This alignment neither creates a quality control nor invents released historical quantity. It does not change the schema, database permissions, reservations, or the signed aggregate's existing checks for status, non-conformities, expiry, derogations, and document requirements. The normal9 isolated HTTP recipe passes all four scenarios, including this historical shipment and its idempotent replay, with an independent PostgreSQL witness of the final counters.

## V2 shipment consumption counters (#1369)

Once the V2 shipment has passed its existing signed quality aggregate, acknowledgement, prepayment, pick and stock gates, the same serializable transaction records each exact shipped quantity in three places: the BL allocation, its ACTIVE stock reservation, and the canonical order-affair allocation. It also decrements the corresponding level and batch reservation counters. A replay returns the durable command receipt before those writes, so it cannot create a second movement or consume twice.

A native V2 shipment may have `qty_prepared = 0`; a reservation-cart shipment may consume only a hold that covers its exact quantity. A nonzero partial hold remains a conflict. Quantity bounds, canonical-source consistency and all existing stock/quality gates remain fail-closed. This rule adds no schema, permission or Quality-policy change.

The targeted PostgreSQL regression passes four cases: native preparation, a fully prepared reservation cart, refusal and rollback for an inconsistent nonzero hold, and decimal aggregation across two lots (0.7 + 0.1). Each successful case verifies the physical, reservation, BL-allocation and canonical counters after an idempotent replay. The test uses the canonical BL version trigger and preserves the active-reservation uniqueness constraint. Policy and document producers are stubbed only within these cases; stock SQL and command receipts run against PostgreSQL. The other 35 cases in the file are outside this targeted selection.

The normal9 HTTP workflow passes four scenarios using the complete isolated schema and real policy/document paths. Its independent PostgreSQL witness confirms two orders, two delivery affairs and two reservations on one BL, each consumed once with zero prepared remainder, correct canonical counters and zero physical/reserved remainder. These results qualify the scoped correction; the complete release gates and deployment remain separate requirements.
