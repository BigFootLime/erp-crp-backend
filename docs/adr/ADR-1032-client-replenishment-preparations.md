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

## Durable root identity (generation mutation still pending)

The additive root-evidence schema binds one anticipated draft root to each immutable proposal and preserves its quantity, original target, applicable PT/version, article and unit. It checks the contract owner, unbound commercial links, actor and draft state at insertion. A concurrent second insert cannot reuse the same proposal or root. A superseded proposal and an already started or received producer are rejected. Launch acknowledgements are immutable and actor-scoped idempotency keys are unique.

Application privileges intentionally exclude UPDATE/DELETE on this evidence and on proposals. The root guard locks the mutable current plan, while reading immutable proposals without an unnecessary UPDATE privilege. The separate PostgreSQL17 test uses an empty disposable database and exercises these canonical application privileges, identity mismatches, concurrency, immutable acknowledgements and unused-only rollback. No ERP database or generation endpoint is changed by installing the schema alone.

## Canonical generation transaction primitive (not routed)

The internal launch primitive requires the existing OF generation capability and a caller-owned SERIALIZABLE transaction. It rereads the shared preparation in that same transaction, checks current contract/plan/coverage and all selected server quantities before invoking the existing recursive generation engine. Roots are unbound anticipated drafts with the applicable PT version, immutable proposal identity and original target, including an overdue target. Launch acknowledgement, root proofs, audit and realtime outbox use the caller transaction. Durable replays return their original result without another OF or success event. Engine, proof, audit and outbox failures propagate to the transaction owner; this primitive never commits independently.

Port-level tests exercise stale shared coverage, ownership/capability refusals, durable replay conflicts, quantity validation before the first generation, canonical parameters and transaction failure propagation. They do not replace a real-engine PostgreSQL/business recipe. This primitive remains unrouted until the received/grouped-producer adapter, outer commit reconciliation and conflict mapping are implemented. The current PREPARE service still uses the physical-only snapshot; no deployed endpoint generates an anticipated OF in this increment.

## Persistent producer reader (not connected to PREPARE yet)

The persistent reader now derives grouped identities from active consolidation allocations and matches only the exact source IDs published by canonical coverage. It checks root/client/PT/version/article/unit identities and validates exact received quantities. A share uses its own received attribution, never the entire producer quantity. Fully attributed received units are retired from the intention budget, including after later stock consumption, while actual stock remains counted by the existing coverage reader. Fully settled closed roots leave the query scope. A later attachment to a firm order restricts that intention to its own order line.

Pending quality output, terminal unexplained quantities and grouped losses without source attribution require an explicit review; they never cause a guessed replacement or false delivery coverage. This does not yet resolve grouped scrap or pending-quality disposition reconciliation. PostgreSQL tests exercise the real query with minimal application privileges, partial quality attribution, retired output and distinct grouped shares. The reader and launch primitive remain unrouted, and the PREPARE service is still unchanged. Outer transaction reconciliation, interface, planning dates and combined business acceptance remain unfinished.

## Routing permission boundary

The eventual generation endpoint must live under the production module gate. An ordinary client-module grant cannot be promoted by the legacy OF role helper's global granted context; the launch primitive checks both the module and authenticated actor before SQL. Explicit elevated access retains the canonical policy. No existing role/module access is changed and no generation route is introduced here.

## PREPARE connected to shared producer intentions (feature not deployed)

PREPARE now reads persistent producer intentions alongside the canonical shared physical allocation in its caller transaction. The preparation fingerprint includes this intention context; a new snapshot cannot silently reuse a plan computed before an OF was created. Only additional-launch proposals change. The delivery coverage report, stock quantities and OTD coverage stay unchanged. A producer requiring quality/group-loss review stops preparation before plan, audit or outbox insertion. Missing root/receipt-attribution schemas return an actionable409 before querying absent tables. This feature requires the root migration; it is not deployed and generation is still an internal unrouted primitive.

## Launch service commit boundary (feature not deployed)

The internal generation service owns the canonical realtime transaction with SERIALIZABLE isolation. It validates and canonicalizes the selected UUIDs, uses the same connection for the shared coverage and producer budget, and passes only server proposals to the existing launch primitive. The acknowledgement reader is shared between launch replay and COMMIT reconciliation; only the same actor/key, owner, request hash and launch identity prove a committed result. An uncertain COMMIT remains uncertain rather than starting another generation. Concurrent serialization, deadlock and known root uniqueness conflicts are actionable409s; unrelated engine/database failures are preserved. Missing launch schema is an explicit409, not an absent-table server error. No generation route, migration deployment, stock mutation or native publication is enabled by this service. Quality/group loss disposition and scheduling targets remain separate acceptance gates.

## Anticipated targets in central planning and PIC/PDP (feature not deployed)

The read-only target adapter keeps the original proposal target on its unbound root and children, and on an active grouped producer through its remaining source shares. A cancelled source, cancelled group, fulfilled share or root subsequently bound to a firm order cannot keep imposing that anticipated target. Central tasks and PIC/PDP use the original target alongside any earlier commercial need; estimated or committed finishes remain separate, and no slot or OF date is written. Existing installations without the additive root schema retain their current planning reads. The target adapter is exercised with real root/child/group SQL and application privileges on a disposable database. Legacy CADRE reconciliation and quality/group-loss dispositions are still acceptance gates.

## Production handoff (feature not deployed)

Generation now publishes canonical production invalidations for every root and child, using the immutable audit identity. Planner inbox notifications are persisted per root with a direct OF link and original target, in the same transaction as generation and its launch acknowledgement. Dedicated `OF_REPLENISHMENT_CREATED` routing uses active primary/additive roles or designated active users; when that topic has never been configured, the existing `OF_PLANNING_SUBMITTED` configuration supplies the recipients. Explicitly disabled dedicated routing never falls back. There are no hardcoded people or external emails. Root/child events and inbox delivery are deduplicated, and a durable launch replay invokes neither. A notification/outbox failure leaves rollback to the owning service. This remains unrouted and does not replace the pending live generation recipe. During audit, the older `of-versioning.notifyTopic` was found to return recipients without persisting its prepared notification; that separate planning-submission defect remains to be corrected independently.

## Production generation API (feature not deployed)

The earlier internal-only generation boundary is now exposed as `POST /production/clients/:clientId/contracts/:contractId/replenishment/commands`, behind the production module and canonical OF generation capability. Only `GENERATE`, a persisted plan UUID and distinct proposal UUIDs are accepted; quantities, technical identities and original targets remain server-owned. The idempotency key is caller-owned and mandatory. A fresh acknowledgement returns201, its durable replay200 with `Idempotency-Replayed: true`. Coverage changes, pending quality/group-loss disposition or unresolved legacy contract evidence remain explicit409s before generation. This API registration does not bypass those guards, mark proposals feasible or complete the real engine/business acceptance recipe. Preparation stays in the client module; generation stays in production. Neither endpoint is deployed until the additive migrations and frontend workspace are integrated.

## Validation and migration

Domain and service tests cover fixed quantities, date retention, fingerprint changes, strict request validation, retries, concurrent version conflicts, audit failures and transaction ownership. A disposable PostgreSQL 17 test verifies real repository SQL, one-current-plan concurrency, identity/quantity/target guards, immutable events and rollback refusal once evidence exists. It refuses ERP databases and existing schemas. The migration is additive, depends on forecast conversion #1032 and includes preflight, verify and unused-installation rollback scripts.
