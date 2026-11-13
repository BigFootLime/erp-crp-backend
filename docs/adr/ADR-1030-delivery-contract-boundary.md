# Delivery contract boundary — #1030

The authoritative scope is `client_contract_calls.contract_id`, saved atomically with the canonical order. Similar customer references, current master-contract status and article names cannot establish compatibility. Contract closure or a new article index does not rewrite a recorded call.

All canonical order sources are resolved from the BL header, actual order lines, order-affair allocations and reserved allocations. A BL accepts one client and a single contract identity, or only non-contract orders. Bound and unbound lines cannot be mixed inside a contract BL. Historical CADRE orders keep one scope per historical order until an explicit reprise supplies a proven contract identity.

The common repository guard runs inside existing write transactions after draft changes, before events/archives/commit. It also runs before preparation and in both shipment paths. The shipment preview exposes the blocking reason and includes the contract group in its confirmation hash. Idempotent replay returns the original committed result and never repeats stock consumption. Existing stock, quality and destination checks remain active.

`GET /livraisons/preparation-cart?include_contract_scope=true` adds `contract_group_key` and the saved `contract_reference`; the omitted flag preserves the response shape for older strict consumers. The frontend opts in, guides compatible selections and blocks unknown scope instead of assuming it means no contract. Backend checks remain mandatory regardless of that flag.

This increment does not certify proforma/payment isolation or the full affair backlog table. No dedicated proforma aggregate or authoritative affaire/payment linkage was found in the audited source. An ordinary invoice or free-text document is not treated as proof of a proforma. These remain explicit #1030 work, as does historical reprise under #1031. No historical BL/order is backfilled or reclassified.
