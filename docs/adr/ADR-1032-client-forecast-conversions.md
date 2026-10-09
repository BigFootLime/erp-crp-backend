# ADR — Explicit conversion of customer forecasts into canonical firm calls

Status: implemented; common business/UI acceptance prepared, not executed.

Monthly estimates belong to the client master contract article family and unit. Firm orders retain the currently proposed validated article and technical version. Changing an index does not rewrite the initial forecast snapshot or previous firm calls.

The existing order creation transaction accepts `client_forecast_allocations` on firm contract lines. It checks contract and forecast versions, active state, family/unit, nonduplicate estimates and remaining quantities. Actor/key replay uses the existing exact order/file digest and precedes allocation checks. No estimate is matched or consumed implicitly.

Allocations are append-only evidence linked by composite foreign keys to the estimate and canonical call line. Database guards serialize each estimate and firm line, bound the cumulative quantity, preserve actor/snapshot/version and advance the estimate version. Stock, shipments and OFs are untouched by conversion. A cancelled estimate withdraws only its unconverted remainder; recorded firm demand is retained.

The API exposes estimated, converted and remaining quantities plus paginated linked-order history. The UI uses existing CERP selectors, fields and tooltips, and sends a partial conversion through the normal guided order path. Subsequent order updates omit creation-only allocation input; reducing below retained allocations receives a business conflict before the database guard. Reversing a firm conversion requires a separate audited correction, never deletion or automatic reinstatement of an estimate.

Cumulative coverage, fixed replenishment batches, OF proposals and manufacturing generation remain subsequent #1032 increments. Common end-to-end acceptance is deferred to the end of the métier chantier by user instruction. Incremental compilation/schema/release readiness does not imply that recipe has run.
