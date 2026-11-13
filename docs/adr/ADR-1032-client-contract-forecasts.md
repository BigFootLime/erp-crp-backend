# #1032 — Explicit customer monthly estimates

Status: first increment implemented; common acceptance pending.

Customer estimates belong to client master contracts, separate from machine-duration/placement forecasts. One retained estimate per contract line and civil month records quantity, estimated delivery due date and date received from the customer. Active and withdrawn estimates remain visible. Editing uses contract and estimate versions; identity, unit and the initial validated article snapshot remain immutable. Contract index evolution does not rewrite historical estimates.

The client API requires ordinary authentication and client write permissions. Client/contract locks serialize revisions with contract changes. Exact actor/key replay, immutable before/after evidence, audit and realtime outbox commit together. An uncertain response retains the original request. SQL remains in the repository. No estimate creates a firm order, OF, purchase or stock reservation.

The next increments add explicit forecast-to-firm allocations, cumulative compatible FREE/quality-released stock plus on-time validated remaining producer OFs, stable fixed-batch replenishment proposals and generation through the canonical recursive OF engine. These calculations are not reported as implemented by this increment. Forecast-based article/unit changes must retain history rather than rebind existing demand.

The future Stock/UI/animation refonte was approved on 9 October and starts after the current métier flow and combined acceptance. This increment reuses existing CERP fields and tables; no new visual framework.
