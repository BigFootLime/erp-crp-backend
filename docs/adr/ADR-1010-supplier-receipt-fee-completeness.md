# ADR-1010 — Supplier receipt fee completeness

Issue #1010, WP278. The declared subcontracting receipt estimate previously added an independent fraction of the purchase-line flat fee to every receipt. Overreceipt exceeded that fee; separately rounded fractions could lose the residual. Header transport was omitted despite lacking a line allocation.

The read adapter now orders active physical receipts by their canonical receipt-line IDs and partitions by purchase line. The fee is the difference between two rounded cumulative allocations, clipped to the ordered quantity. Their sum reaches the exact fee at full receipt and never exceeds it. Unit-price quantity remains the actual received quantity, including overreceipt. PostgreSQL numeric computes the amount at the existing Margin engine's six-decimal precision; no JavaScript financial number or guessed currency conversion is introduced. This deterministic order is an estimate allocation rule, not a claim about physical FIFO.

Positive/unknown header transport, missing/invalid ordered quantity, non-finite or invalid price facts, and an unproven zero-price receipt leave the amount null with UNKNOWN monetary evidence and an explanatory definition. Transport is not silently assigned to one OF or distributed across unlike units. A properly matched, approved, archived and allocated invoice remains separate verified evidence. A partially invoiced source retains the known invoice amount and an explained unknown remainder; a fully covered approved invoice can establish cost.

This corrects future read estimates only. It does not modify physical receipt quantities, invoice approvals, previous versioned margin snapshots, Stock acquisition captures, valuation journals or CUMP activation. No schema migration. Actual allocation of header transport and late invoices into physical inventory/consumption remains a separate tracked integration.

TypeScript/build/OpenAPI and SQL PREPARE/EXPLAIN in ROLLBACK on Test/Prod are technical delivery gates. The two new reconciliation fixtures and numerical/business scenarios are prepared NOT RUN until the requested final combined acceptance; delivery evidence is recorded in the issue.
