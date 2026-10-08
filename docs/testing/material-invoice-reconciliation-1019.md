# Combined acceptance: material invoice reconciliation — #1019

Status: **NOT RUN**. Business, RBAC, UI, concurrency and financial tests remain
reserved for the final combined acceptance at the human's request. Colocated
fixtures below are prepared, not executed. Immediate checks are strict types,
OpenAPI/build, six actual queries PREPARE/EXPLAIN without ANALYZE in ROLLBACK,
then deployment backup/readiness/version/routing evidence.

1. Approved 100 units / receipt value 1000 / invoice HT 1200 / remaining 40:
   delta 200, Stock 80, consumed 120; DECLARED original reliability preserved.
2. Header charge/discount: full invoice proportional-cent approval required;
   missing or altered archive/approval source leaves the allocation unknown.
3. Partial invoice, credit, shared receipt, duplicate receipt and another
   approved invoice: explained unresolved, no partial monetary result.
4. Two distinct lots: cumulative deterministic allocation preserves all
   twelve-decimal residuals. Different article/unit quantities stay separate.
5. Purchase/Stock conversion: captured coefficient and actual quantities agree;
   unknown coefficient or cross-unit sum cannot create a proposal.
6. Original receipt entry/hash/acquisition/posting missing: UNKNOWN, never
   today's catalogue/order price. Client-owned material stays excluded.
7. Positive legacy opening, mixed incoming, return and reversal: UNKNOWN.
8. Physical Stock remainder matches receipt minus OUT/SCRAP/DEPRECIATE; parent
   level is not added again. Reservation does not consume quantity.
9. Neutral internal transfer requires all three immutable parent/out/in rows
   with matching lot quantities; incomplete group cannot affect attribution.
10. Fully consumed stock gives zero Stock delta and complete consumed delta;
    projection readiness remains false pending its separate posting extension.
11. Missing, PREPARED, pending or unknown Stock balance is explained separately
    from calculable arithmetic. No activation or entry is written by GET.
12. Changed batch/posting/fiscal/approval/projector source changes the SHA;
    subsequent financial confirmation must re-read it, not trust this preview.
13. Finance permission absent: 403; unauthenticated: 401; invalid UUID: 422;
    missing invoice: 404. Database/session routing stays isolated.
14. 501 source lines/receipts/lots, 2001 traces, proof-byte/deadline limits:
    incomplete/busy response, no misleading truncated sum or generic 500.
15. Existing invoices, Stock posting/receipt, supplier approval and immutable
    OF costs remain compatible. GET is private/no-store and causes no write.

Seven fixtures cover exact split, missing original cost, partial/legacy/already
invoiced sources, transfer group, mixed receipts, changed projection source,
signed discounts and exhausted stock.
All are **prepared NOT RUN**; screenshots and end-to-end acceptance remain due.
