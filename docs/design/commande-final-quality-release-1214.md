# Final quality coverage for delivery

Issue #1214, WP 287. Command delivery accepts validated FINAL controls on completed operations belonging to each OF, or RECHECK/LOT_RELEASE controls on its actual produced lots. Output quantities cap lot coverage. Independent operation and lot channels use the maximum rather than addition, preventing duplicate checks from releasing an incomplete population. Raw-material lots and controls of another OF do not qualify. Open non-conformities still block. No schema or authentication change.

Validation: 12 fulfillment regression tests, strict build, actual PostgreSQL read-only S03 query returns 3 active OF, 0 unreleased, 0 open NC. Normal UI BL/invoice replay remains required.

## Historical OLD lots in V2 shipment

A V2 shipment continues to require the signed delivery-quality aggregate before any stock movement. For an OLD lot with no current CERP control ledger, the operational lot gate is omitted only when every exact allocation in the physical group is represented by the aggregate as OLD, has no controls, has no current lot control, and carries a server-side historical document reference. Missing allocation metadata, a current control, NEW provenance, or missing evidence keeps the operational gate in force.

This alignment neither creates a quality control nor invents released historical quantity. It does not change the schema, database permissions, reservations, or the signed aggregate's existing checks for status, non-conformities, expiry, derogations, and document requirements. The HTTP shipment proof remains pending the isolated end-to-end recipe.
