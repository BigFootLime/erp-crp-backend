# Supplier purchase-order freeze and archived PDF (#1270)

Approving and freezing BCF-2026-1304 previously saved only its legacy JSON document. The authoritative PDF list still offered its creation draft. A new approved freeze now queues the PDF and its durable archive job in the same transaction as the commercial document and audit. An archive failure rolls back the freeze.

## Preserved history and retries

- The existing creation draft remains immutable; approved PDFs receive the next archive edition (`max + 1`). Legacy commercial document version and PDF archive edition are separate counters.
- Normal UI requests carry the precise order revision. Repeating the same revision and reason returns the accepted freeze even after the order is sent. Clients omitting the revision keep their existing behavior; no ambiguous retry guarantee is claimed for them.
- Explicit reissue requires the current source revision and a reason. Its commercial content comes from the last verified freeze, never from subsequently edited prices or quantities. Frozen CGA selection is preserved.
- Pre-fix documents lack a complete PDF identity. Their corrective first issuance is dated now, using identities checked now, and preserves their immutable commercial data. It is not backdated. A missing historic delivery address is not invented.
- The PDF explains any frozen net amount beyond discounted quantity × price as a price supplement; it does not guess a historical flat-fee or minimum-billing rule.

## Validation

85 focused Vitest assertions and a strict TypeScript build. The executable `scripts/tests/supplier-document-freeze-1270.cjs` requires the disposable database `supplier_document_1270` and a private GED vault. It restores the Test backup, runs actual repositories and the selected authoritative archive worker, and checks 14 cases: stale source/reason refusal, legacy 18+2 at EUR6 and EUR192 total, transaction rollback on outbox failure, freeze replay after sending, immutable draft history, later mutable prices excluded, and identical PDF bytes on repeated GED reads. The harness removes only its isolated database.

The rendered corrective and new-freeze PDFs are visually checked. No live Test/Prod write, customer mail, physical printing, installed desktop validation or complete business-scenario validation is implied by this test. Live BCF-2026-1304 reissue must still be replayed after deployment. General CGA attachment and all other S12 document scenarios remain in the broader recipe.
