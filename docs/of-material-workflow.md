# OF dossier completion and material coverage

Delivery in progress: backend #767, frontend #1025–1032, Project Office WP-254. The governing decision is frontend ADR-0072; activation defaults to off.

## Current interfaces

- GET /production/workbench/config includes material_workflow_enabled.
- GET /production/ofs/:id/dossier reads preparation, committed operations, customer/internal/committed/forecast/actual dates and validation blockers.
- POST /production/ofs/:id/complete validates the frozen technical definition and actual committed planning, retaining actor/version evidence. It never starts production.
- GET /production/ofs/:id/material reads frozen purchase needs, their operation configuration, canonical reservations and purchase allocations, FIFO candidates and net shortage.
- POST /production/ofs/:id/material/:sourceRef/configure records the reviewed material specification and debit rule. Changes require dossier revalidation; existing commitments remain.
- POST /production/ofs/:id/material/confirm applies the reviewed selection and creates supplier/currency/destination-compatible purchase drafts for the uncovered quantity.

Writes require expectedVersion and idempotencyKey. Replayed commands validate actor and payload. Coverage uses a locked OF and canonical stock quality/availability gates; drafts use existing purchase numbering, line insertion, creation documents and audit. Failed transactions roll back reservations and purchases together. Prices are removed from the public read model when purchase-price rights are absent.

## Canonical ledgers

of_material_needs attaches specifications to an OF technical version and consuming operation. stock_reservations retains physical quantities, consumed quantities and source identity. commande_fournisseur_ligne_besoin retains future promises; OF_MATERIAL permits separately traced partial promises while the unique-link policy remains for legacy source types. of_material_receipt_transfers links an incoming stock receipt to its resulting reservation and deduplicates reconciliation; it must never be counted as extra physical stock.

The dossier source fingerprint excludes slot dates/resources so ordinary moves do not invalidate the prepared product. Deferred planning triggers see the transaction's final schedule and invalidate only after withdrawal. Definitions and quantities trigger revalidation immediately.

## Rollout and verification

Both additive migrations have preflight/verify files and a recovery guide under db/patches/support. Test first, retain application ownership and migration UTF-8 hashes. Do not remove ledgers for rollback. A disabled UI is not permission to bypass persisted allocations through legacy routes.

Policy tests cover net 40/15, FIFO rejection, shared pool depletion, repeated confirmation, transfer to physical/consumed, quarantine, supplier surplus and explicit bar/sheet conversion. Read probes use cerp_test under cerp_app; trigger checks roll back all their test writes. Business recipe is exclusively through the UI. Full receipt reconciliation, customer calls, supplier consultations and operation start/partial consumption are still being implemented; the presence of a schema or pure function does not imply their delivery.
