# #1013 — Documented HT amounts outside supplier invoice lines

WP-278, complementary audit N23. #1010 keeps unallocated transport and estimates unknown. Supplier invoice lines, matches and decisions are append-only under #675; use their existing approval ledger rather than rewriting fiscal lines or adding monetary input fields.

## Decision

`GET /supplier-invoices/:id/header-allocation` is Finance-read scoped, private/no-store and read-only. It proposes `PROPORTIONAL_NET_V1` from the **complete invoice**, not only one OF: exact HT invoice total minus the exact sum of fiscal line HT amounts. Proportionate absolute net amounts and cumulative rounded differences retain every cent deterministically in position/UUID order. BigInt cents preserve amounts above JavaScript integer precision. A difference may be a charge, discount or rounding adjustment; the backend does not invent a transport classification.

All nonzero differences require a complete matched purchase-order scope and matching supplier. Missing/duplicate fiscal lines, mixed signs, unsupported money, zero weights, invalid archives or missing document versions make the proposal ineligible. All actual fiscal lines, associations and archived document hashes/versions participate in the canonical SHA. Workflow row version is checked separately; it is excluded from the monetary SHA so closing/exporting a valid invoice does not invalidate its evidence.

`POST /:id/approve` accepts an optional explicit method/source SHA. No amount, percentage, line or receipt ID comes from the caller. Under the invoice lock, the server recomputes the proposal, compares the SHA, rechecks/locks archived files, then freezes the calculation in the existing append-only approval decision. Identical actor/key intentions are serialized before reading the durable command receipt. Approval, decision, provider outbox, receipt and audit remain one existing transaction. No approval is performed by the coding agent.

Compatibility: an approval without a choice remains available. A nonzero unallocated difference remains **UNKNOWN** in costing, including a one-cent difference; the former one-cent tolerance is not monetary allocation evidence. Existing approved invoices and snapshots are not backfilled. Invalid/stale selected proposals fail with 409; read errors must not be treated as an absence of charges.

The subcontract cost reader receives the complete source/proof once per invoice, recomputes it once, and uses the documented amount for each explicitly scoped line. Credit-note polarity, supplier/receipt/archive/unit/currency and cumulative billed-quantity checks remain in force. This creates a new cost input for future calculations; prior margin snapshots are immutable.

## Scope and limits

No schema migration, fiscal amount rewrite, physical receipt change, stock valuation entry, journal backfill or CUMP activation. The material acquisition transport cursor and late-invoice stock/consumption allocation are separate remaining owner integrations. This contribution delivers the backend contract first; the Finance UI selection follows immediately. Unit, security/concurrency and business acceptance are prepared **NOT RUN** until the final combined acceptance requested by Keenan.

Backend graph export absent; relevant routes/controller/repository, #675 constraints and grants, Finance authorization, Margin SQL/domain and frontend callers inspected directly. Do not infer completeness from the available frontend graph.
