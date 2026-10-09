# Changelog

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
