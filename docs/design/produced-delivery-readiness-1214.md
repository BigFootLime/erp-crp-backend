# Final quality coverage for delivery

Issue #1214, WP 287. Command delivery accepts validated FINAL controls on completed operations belonging to each OF, or RECHECK/LOT_RELEASE controls on its actual produced lots. Output quantities cap lot coverage. Independent operation and lot channels use the maximum rather than addition, preventing duplicate checks from releasing an incomplete population. Raw-material lots and controls of another OF do not qualify. Open non-conformities still block. No schema or authentication change.

Validation: 12 fulfillment regression tests, strict build, actual PostgreSQL read-only S03 query returns 3 active OF, 0 unreleased, 0 open NC. Normal UI BL/invoice replay remains required.
