# ADR 1031 — Client-owned contract catalog

Status: accepted for the first increment of #1031, per the confirmed business rules of 2026-10-09.

Contracts belong to the canonical client. Their definitions contain commercial article families, an explicitly supplied replenishment batch quantity and a canonical unit. The catalog only offers validated, sold articles assigned to that client, using an effective applicable technical version. It does not invent a replenishment quantity or infer a contract from an old CADRE order.

The stored article, code, designation, index and technical-version identity describe the definition accepted at that time. The current proposal resolves the latest validated article in the same commercial family and unit for future calls. Missing or incompatible definitions require intervention. Historical commands, delivery promises, OFs, BLs and OTD baselines are not changed by editing this master data.

Create, update and close commands use a captured database/account context, required UUID idempotency key, actor-scoped replay receipt and optimistic version. Parent client locking serializes concurrent catalog mutations. Definitions, immutable before/after events, audit and realtime outbox commit together. Unknown outcomes must retry the exact body/key. Updates and closure require a reason; closure preserves lines and history.

Use additive tables and the existing canonical PostgreSQL, client permissions, unit registry, technical versions, audit and realtime ownership. No separate UI-only contract state is authoritative. Receipt evidence and existing orders are untouched by this migration.

The next #1031 increment must bind firm orders to contract/version/line snapshots, present previous calls and preserve explicit historical CADRE migration decisions. #1030 then uses those identities to enforce BL scope compatibility. Catalog deployment alone does not complete these requirements.
