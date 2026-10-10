# ADR #1032 — Preparations are immutable evidence, not available supply

## Context

Customer contracts define fixed replenishment lots. The shared coverage engine already subtracts actual remaining firm deliveries, unconverted forecasts, quality-released stock and secured production once across competing contracts. The read-only fixed-lot projection carries its proposed surplus through subsequent months.

A saved proposal must not make a draft OF appear deliverable. Retrying a request must not erase evidence or create another proposal identity. A changed stock, technical definition, forecast or planning commitment must force recalculation.

## Decision

- The existing coverage service exposes a transaction-scoped internal read. Public coverage retains its read-only transaction and only exposes data belonging to the requested contract.
- `PREPARE` rereads that shared calculation under a repeatable-read transaction, after locking the client, contract and applicable articles. The submitted contract version, previous plan identity and displayed coverage hash are concurrency proofs; the browser supplies no quantities or article definitions.
- A fingerprint excludes the volatile read timestamp, while including the shared allocation hash, Paris calendar date, horizon and selected technical identities. A different idempotency key for the same fresh calculation keeps the same plan identity. An identical key returns the originally recorded result.
- `client_contract_replenishment_plans` stores the canonical coverage snapshot. Only the current plan may become superseded; quantities, dates, identity and audit evidence remain immutable. There is one current plan per contract, including an explicitly empty plan when no replenishment is needed.
- Positive monthly proposals store the number of fixed lots, exact three-decimal quantities, original prior-month-end target, applicable article/index/PT version and projected surplus. They never increase stock, reservations or production coverage. An overflowing or over-precise projection is rejected rather than rounded.
- Immutable events, audit logging and realtime outbox commit with the preparation. Lost acknowledgements are reconciled using the durable replay record. Serialization/deadlock conflicts return an actionable 409.
- Reading preparation history checks both client and contract ownership. Preparation uses the existing client-write role gate. It does not grant any OF generation capability.

## Explicit remaining work

This increment exposes preparation evidence only. Canonical recursive OF generation, cross-contract reconciliation of previously generated quantities, link to planner actions and material procurement, feasible planning dates, cancellation/scrap/grouped-producer cases and browser business acceptance remain separate unfinished acceptance criteria of #1032. Preparations must never be treated as real coverage to close those criteria.

Any future generation path must recheck shared coverage and generation permissions in its own transaction, reuse the canonical generation engine, preserve the original target and record every generated root against its proposal. Previously generated drafts need an explicit intent reconciliation; otherwise a refresh could duplicate production even though it correctly excludes drafts from available coverage.

## Additional-launch intention calculation (not routed)

The pure `prepareContractReplenishmentWithIntents` adapter allocates existing producer intentions once across all competing contracts after canonical physical/secured coverage. It subtracts any already counted producer allocation from that producer's intention budget. Only the additional-launch projection changes; actual delivery shortages and OTD coverage remain unchanged. The preparation fingerprint includes this separate intention context, so a changed draft cannot silently reuse an earlier launch calculation.

For actual shortages17/28/5 and lot20, an existing draft20 leaves only an additional40 proposal. Existing drafts20+40 leave no additional proposal and10 unassigned units, while actual cumulative delivery shortages still read17/45/50. A later draft target is retained and explicitly marked for planner review. No stock, reservation or delivery date is changed.

This domain increment is not connected to an API, database intent reader or generation mutation yet. Its caller must supply authoritatively reconciled producer identities. Received and grouped/ambiguous producers currently require reconciliation; the guard prevents duplicate generation rather than pretending these cases are finished. Persistence of roots, canonical generation, received/grouped adapters and frontend acceptance remain unfinished.

## Validation and migration

Domain and service tests cover fixed quantities, date retention, fingerprint changes, strict request validation, retries, concurrent version conflicts, audit failures and transaction ownership. A disposable PostgreSQL 17 test verifies real repository SQL, one-current-plan concurrency, identity/quantity/target guards, immutable events and rollback refusal once evidence exists. It refuses ERP databases and existing schemas. The migration is additive, depends on forecast conversion #1032 and includes preflight, verify and unused-installation rollback scripts.
