# Changelog

## Reservation-cart shipment promises — 2026-10-10

- Allow verified partial reservation-cart preparation and retain the consumed/restant quantities. Keep legacy preparation and shipment exact by default. Backend #1110 / OBS061.

- Capture immutable delivery promise quantities/dates in the reservation-cart shipment transaction, alongside stock and receipt/outbox writes. Preserve shipment retry idempotency and proof-based OTD. Backend #1109 / OBS060.
- Append documented reconciliation for proven historical unchanged promises only; revised, partial or unsupported evidence remains flagged for explicit review. Original AR and stock/movement records are retained.


## Independent fixed-lot replenishment roots — #1032 — 2026-10-10

- Create one canonical draft OF per fixed contract lot, with distinct stable identities, original targets and all root links in the workspace. Validate the full selection before generation and return every root on durable replay.
- Add an immutable per-lot identity and deferred completeness guard; preserve legacy acknowledgements and forbid partial or mixed launches. PostgreSQL and common business acceptance remain under validation.

## Contract replenishment preparation — 2026-10-10

- Save immutable fixed-lot proposal snapshots, original targets and applicable technical identities. Recompute the shared coverage in the caller transaction, require freshness proofs and preserve idempotent replies, audit and outbox. No OF, stock, reservation or purchase is created.
- Add guarded PostgreSQL preparation evidence, one current plan per contract and unused-only rollback. WP-286 / #1032 generation and full business recipe remain in progress.

## Invoice reference catalogue — 2026-10-10

- Return qualified billing-frame code/category/French-label records expected by the published invoice workflow, preserving the canonical catalogue and Finance read permissions. Backend #1105 / OBS059. No migration or legal/provider configuration.


## Delivery document routes and subcontract audit — 2026-10-10

- Validate BL and document UUID parameters together so archived pack PDFs and linked documents can be viewed and downloaded. Preserve document linkage, bounded storage, authentication and deletion conflicts. Backend #1102 / OBS058.
- Use the canonical transactional ACTION audit writer for subcontract custody actions and RELEASE/RETURN, preserving actor, quality gates, transaction and outbox delivery. Backend #1099 / OBS057. No migration.


## Historical stock and packaging audit — 2026-10-10

- Use the shared transactional ACTION audit writer when adding an OLD document reference or creating finished packaging. Preserve idempotency, quality checks and rollback; retain durable audit delivery. Backend #1098 / WP-285 / OBS056. No migration.


## Quality delivery policy audit events — 2026-10-10

- Persist activation as ACTIVATED and return to draft as UPDATED, matching the existing audit constraint. Preserve signed policy contents, release gates and transactional rollback. Backend #1095 / WP-285 / OBS054. No migration.


## Delivery calendar dates — 2026-10-10

- Return delivery-line due dates as calendar text from PostgreSQL in detail, line edit and both preparation paths. A 16 October promise stays 16 October in every timezone, without rewriting stock, orders, promises or existing official documents. WP-285 / OBS051. No migration.


## Recipe email routing — 2026-10-10

- Base Test redirects all outgoing mail exclusively to the recipe owner’s authorized mailbox; other internal and external recipients are excluded. Production routing and the isolated E2E sink retain their existing behavior. OBS050 / WP-285. No schema or authentication change.



## Stock valuation verifier successor — #1087 — 2026-10-10

- Verify the exact six-column #1007 key before #1022 and its seven-column successor afterward, retaining valid `NULLS NOT DISTINCT` uniqueness and the validated invoice correction identity.
- Add seven transactional negative cases to the disposable migration rehearsal. No migration, application runtime, route or permission change. Native publication remains pending complete qualification.
- Test the documented legacy shape with retained archives, prove that the old supplier rollback refuses current financial dependencies, and run the original SOL-06 rollback on its restored source prefix. Preserve immutable-patch validation, current-schema integrity, backup fingerprint checks and failure evidence.

## Customer-facing acknowledgement notes — 2026-10-10

- New AR editions exclude the form’s internal operational markers and priority, while preserving public notes and customer requirements. The snapshot and its exact PDF use one public projection.
- Previously archived editions and raw source fingerprints remain unchanged. OBS048 / WP-285 / #1084. No schema or email-delivery change. Runtime and full business recipe remain pending.

## Customer order v2 fully reserved from stock — 2026-10-10

- Prepare the AR without a fictitious planning gate when the launch reserves the complete order from OLD/NEW and generates no OF. Production, technical preparation and contract supply keep their existing gates.
- Explicit replay repairs only an invalid v2 planning state with exact existing allocation and reservation coverage, no OF/BL/sent AR/pending contract supply. Reservations and delivery affairs are reused unchanged; history and audit remain transactional.
- OBS-046 / WP-285 / #1081. No migration. Full industrial recipe remains in progress.

## Persist OF planning notifications — 2026-10-10

- Persist planning submissions, time variance proposals and AR follow-ups with their realtime outbox in the owning OF transaction. Configured active recipients can open the OF directly. Distinct decisions have distinct dedupe keys; a replay emits no second event.
- OBS-043 / WP-285 / #1032. No migration. Full industrial recipe remains in progress.

## Contract fixed-lot projection — 2026-10-10

- Calculate fixed replenishment lots from authoritative monthly shortages, with exact decimals and surplus carried once into later months. Expose a read-only projection without treating it as stock or creating OFs. Seven targeted regressions; no migration.
- Project Office WP-286 / #1032. Persistence, canonical OF generation and common business acceptance remain in progress.

## Metrology measurement persistence — 2026-10-10

- Persist the computed verdict and deviation with each reading or motivated correction, without a second unversioned update rejected by the canonical history trigger. Preserve the trigger, audit, idempotency and validated execution immutability.
- Regression reproduces initial and corrected reading failures. 120 targeted tests pass. No migration; WP-285 full recipe remains in progress.

## Supplier recommendation context — 2026-10-10

- Return the validated numeric OF identity in supplier recommendation evidence when PostgreSQL bigint identifiers arrive as strings. Preserve permissions, ranking and coherent read scope.
- Regression reproduces the browser contract failure with default bigint driver values. No migration. WP-285 full recipe remains in progress.

## Preserve purchases in technical revisions — 2026-10-10

- Preserve purchase dimensions, cutting coefficient, supplier details, price basis, VAT and totals when copying a technical version. Source rows and frozen dossiers remain unchanged.
- PostgreSQL 17 regression fixture verifies values, nulls, zero prices and source scope. WP-285 full business recipe remains in progress.

## Recipe conditional trigger precision — 2026-10-10

- Preserve the conditional OF dossier invalidation trigger while widening numeric precision. Restore its definition, enabled mode and comment inside the same transaction.
- Isolated PostgreSQL application/replay and history/permission checks passed. WP-285 business acceptance remains in progress.

## Recipe decimal precision — 2026-10-10

- Retain fractional technical unit prices and method/OF times with six decimal places. Preserve historical values and the active-execution view permissions; monetary totals remain in cents.
- Isolated PostgreSQL application/replay and history/permission checks passed. WP-285 business acceptance remains in progress.

## Complete backend acceptance fixtures — 2026-10-10

- Register seven CUMP suites in Vitest; refresh contract, lane and scope fixtures without weakening runtime guards (#1059).
- Baseline failures reproduced; affected replay passed (15 files / 149 assertions). Full frozen run required before merge.

## Contract recipe corrections — 2026-10-10

- Create manufactured client articles as sellable, lot-tracked units. Preserve existing links and historical articles; no schema migration.
- Targeted tests passed; full business acceptance remains in progress (WP-285).

## Cumulative client demand coverage — 2026-10-09

- Project remaining firm/forecast demand against shared quality-released stock and committed on-time producers.
- Preserve dedicated stock/producer shares, consume each source once, retain monthly targets and expose a read-only CERP panel.
- Common métier/UI acceptance prepared NOT RUN; fixed-batch OF proposals/generation and historical CADRE release mapping follow separately.

## Explicit forecast conversion — 2026-10-09

- Convert monthly estimates into the canonical firm order aggregate with explicit retained allocations.
- Preserve estimate/firm quantities, versions and immutable links; enforce exact replay, guards and atomic outbox.
- Common métier/UI acceptance prepared NOT RUN; cumulative coverage and fixed-batch OF proposals follow separately.

## Monthly customer estimates — 2026-10-09

- Record monthly customer estimates on contract article families with quantity, due date and customer estimate date.
- Preserve historical article/unit/month identities and audited revisions; enforce versions and exact actor/key replay with atomic outbox.
- Common métier/UI acceptance prepared NOT RUN; firm conversion, cumulative coverage and fixed-batch OF proposals follow separately.

## Historical CADRE association — 2026-10-09

- Explicitly associate historical CADRE with same-client contracts using actual family/unit identities and immutable source snapshots.
- Preserve ordered indices, AR/OLD/stock evidence; enforce canonical composition and BL scope, audit and exact request replay.
- Common métier/UI acceptance prepared NOT RUN; dedicated proforma payment isolation remains pending.

## Delivery affair backlog — 2026-10-09

- Show article affairs before stock reservation; retain client/PO/technical identity and initial sent-AR evidence.
- Separate reserved/prepared/shipped counters and partial/complete states; scope the canonical BL cart to the selected affairs.
- Common métier/UI acceptance prepared NOT RUN; proforma and historical reprise remain pending.

## BL contract compatibility — 2026-10-09

- Resolve canonical contract identities across all BL source orders; reject ambiguous mixtures before commit or stock consumption.
- Guide selections with opt-in contract metadata while preserving legacy strict cart responses.
- Common métier/UI acceptance prepared NOT RUN; proforma/payment isolation and affair backlog remain pending #1030 work.

## Client contract calls — 2026-10-09

- Bind firm calls to client master contracts through the canonical order aggregate.
- Preserve initial article/index, quantity/date and actual canonical line identity, with atomic replay, audit and outbox.
- Use CERP source fields, historical call tables, scoped retries and proactive identity/retention guards.
- Combined business/UI acceptance prepared NOT RUN; explicit legacy CADRE migration remains pending.

## Client contract catalog — 2026-10-09

- Add client-owned contracts, validated article-family selection and explicit replenishment batches.
- Keep recorded technical definitions immutable; resolve future proposals without changing historical orders.
- Enforce role, active client, optimistic version and actor-scoped idempotency with atomic audit/realtime.
- Combined business/UI acceptance prepared NOT RUN; firm-order calls remain pending.

## Reservation-backed lane routing — 2026-10-09

- Configure one explicit physical receipt destination per lane; activate only when all three are valid.
- Route new released output using canonical transfers; preserve receipt, lot and reservation evidence without consuming prepared BLs.
- Serialize topology and Quality/receipt mutations before stock access; retain historical positions unchanged.
- Combined business/UI acceptance prepared NOT RUN by user instruction.

## Released production attribution — 2026-10-09

- Reserve actual affair remainders in current AR order without counting prepared BLs twice.
- Attribute new simple, component, assembly, internal-contract and grouped receipts after real Quality release, with immutable deltas and no duplicate stock entry.
- Restore the receipt response fields required by the existing UI; reject stock quantities exceeding numeric(18,3).
- Physical lane transfers are still inactive. Combined business/UI acceptance remains prepared NOT RUN.

## Physical stock lane foundation — 2026-10-09

- Add versioned physical lane roles and immutable configuration evidence without moving stock or creating another balance.
- Expose canonical per-lot positions, reservation purposes and explicit physical-only availability scope.
- Preserve historical zones, OLD/NEW, quality and occupied reservations; automatic routing remains inactive pending #1029.
- Compile/OpenAPI checks pass; combined business acceptance is prepared NOT RUN.

## Sourced supplier recommendations — #1025

- Add exact OF/version/comparison context, displayed-evidence SHA, current order/catalogue/review references and existing ranking contributions.
- Preserve ranking and price permissions; separate confidence, qualify first and never engage an order automatically.
- Bound coherent PG17 read-only transaction to nine seconds, SQL to two seconds and quality evidence volume; Cache-Control no-store.
- Four fixtures and twelve common acceptance scenarios prepared NOT RUN; local generative service remains to be confirmed.

## Explicit sourced material invoice confirmation — #1022

- Protected Finance/financial Stock intent, full source SHA and actor-scoped UUID replay; no amount input.
- Exact signed Stock/consumed allocation, quantity-neutral balance, proved physical OF attribution and visible unassigned consumption.
- Immutable ledger/guards/audit committed atomically; additive zero-stock candidate, original guard bodies and historic costs preserved.
- Only future explicit margin versions include proved corrections; subsequent return remains unresolved pending policy.
- CUMP PREPARED, no actual financial posting; five fixtures and fifteen common acceptance scenarios prepared NOT RUN.

## Sourced material invoice reconciliation preview — #1019

- Protected Finance read-only receipt/lot proposal, approved invoice and immutable booked acquisition evidence.
- Exact variance split between traced remaining Stock and consumed material, original reliability preserved.
- Shared/old/mixed/partial/credit sources stay explained UNKNOWN; bounded repeatable-read snapshot and full source SHA.
- No financial posting, activation, schema or historical cost change; seven fixtures and combined acceptance prepared NOT RUN.

## Material order transport evidence — #1016

- Freeze complete active purchase-line monetary facts on future receipts; preserve historical proofs and previous capture function.
- Allocate transport by net HT including discount/line flat fees, exact cumulative residuals and capped partial/overreceipt amounts.
- Cursor hash includes the complete monetary basis; changed/removed transport, incomplete evidence and history gaps remain explained UNKNOWN.
- Add reversible capture migration; physical stock unchanged and CUMP PREPARED. Five fixtures and common acceptance prepared NOT RUN.

## Documented invoice header allocations — #1013

- Finance read-only exact-cent proposal for HT amounts outside fiscal lines; no caller amount input.
- Explicit source-checked approval freezes complete invoice/match/archive proof; no historical backfill.
- Subcontract margin source uses documented line allocations; serialized approval intentions and fresh archive checks.
- No physical stock, old margin, schema or CUMP activation change. Combined fixtures/acceptance prepared NOT RUN.

## Supplier receipt fee completeness — #1010

- Cap declared subcontract receipt flat fees by cumulative rounded allocation; exact six-decimal residual across partial/overreceipts.
- Unallocated transport and invalid/unsupported price facts remain explained UNKNOWN amounts; approved invoice evidence stays distinct.
- No physical, historical snapshot, Stock journal or CUMP change. Combined acceptance fixtures/scenarios prepared NOT RUN.

## Valeur actuelle du stock documentée — #1007

- Correction financière entreprise EUR, justificatif article et empreinte du solde, quantité physique inchangée. Historique immuable, idempotence et contrôle financier existant.
- Écriture DECLARED et solde atomiques sous verrou global CUMP ; valeur historique inconnue conservée. Aucune ventilation de facture tardive ni activation.
- Migration/requêtes/retour arrière compilés dans ROLLBACK sur Test/Prod, gardes #983 conservées ; recette commune préparée NON EXÉCUTÉE.

## Dossier replenishment objective — #1113

- Read the original anticipated contract target in the OF dossier instead of requiring the planner to type it again. Preserve customer promises, earlier internal dates, committed slots, and dossier completeness.

## 2026-10-10 — #1116

- Commande client : conserver les dates civiles lors de la duplication ; éviter HTTP500 dû au passage DATE PostgreSQL vers String(Date). Lecture ISO dédiée, sans mutation des délais sources ni reprise des réservations/AR.

## 2026-10-10 — #1119

- Accusé de réception : afficher et archiver le délai de livraison de chaque ligne, sans décalage de jour ni réécriture des anciens AR.
