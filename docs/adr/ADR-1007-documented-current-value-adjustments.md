# ADR-1007 — Documented current stock value adjustments

Status: accepted for implementation; business acceptance and projector activation pending.

Stock owns valuation. A financial approver can document a new total value for current company-owned stock, with no physical movement and no rewrite of historical issue/receipt/manufacturing costs. Append an immutable declaration and zero-quantity financial entry; update the current Stock balance and audit atomically. Use the existing CUMP decimal engine, global projector lock, immutable source chain and margin capability policy.

Retain unknown historical value instead of inventing a delta. Reconciliation against live physical LEVEL/BATCH, client ownership, active article proof and current projector state is mandatory. The sixth posting-uniqueness column separates correction UUIDs while preserving earlier physical/opening uniqueness. Keep original #983 guard definitions unchanged; add financial-specific approval, entry and deferred commit guards.

The endpoint justifies the full current amount. It does not allocate late invoices, transport or header charges between consumed and remaining quantities. Those require separate allocation evidence. Migration and delivery retain PREPARED/uninitialized; no activation is implicit.

Contract, lock order, recovery and prepared final acceptance are documented in [stock-value-adjustments-1007](../stock-value-adjustments-1007.md). This decision follows WP-278 and backend issue #1007; use the tracked patch and its preflight/verify/empty-feature rollback scripts. Business/RBAC/concurrency acceptance is deferred as requested.
