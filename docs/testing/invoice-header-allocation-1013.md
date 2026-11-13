# Common acceptance — #1013

State: **NOT RUN**. WP-278. User defers combined business/UI/RBAC/concurrency fixtures until all implementation ends. Immediate checks cover strict TypeScript/build/OpenAPI and actual query PREPARE/EXPLAIN without ANALYZE, under cerp_app in ROLLBACK on Test/Production. Those are compilation proofs, not business acceptance.

Use synthetic Base Test invoices/receipts only. No real invoice approval or fiscal amount change by the agent.

1. Complete three-line invoice: 33.33 + 33.33 + 33.34 = 100.00; total 100.01. Proposal charges 0.00/0.01/0.00, totals 33.33/33.34/33.34. Source array reversal gives identical result.
2. Total 90.00: allocated totals 30.00/29.99/30.01 exactly. Credit-note positive and negative conventions retain polarity when read as costs.
3. Exact cent above JS safe integer range; no float conversion in preview/approval/proof.
4. All zero weights plus nonzero header, mixed signs, NaN/Infinity, duplicate lines/positions, missing matching order/supplier or line from another order: ineligible, no guessed amount.
5. Complete clean archives including GED document/version/time required at approval. Removed/replaced archive version/hash after preview gives 409; same change after approval yields unknown cost evidence.
6. Finance reader vs unauthorized role; approve capability vs reader; GET no-store; free amount/percentage/lines or unsupported method rejected at HTTP boundary.
7. Stale invoice version/source SHA or new match: original draft preserved, refresh and explicit new review. No automatic resubmission/approval.
8. Two identical actor/key concurrent approvals: one immutable decision/outbox/command receipt/audit; retry returns original response before stale version checks. Busy result keeps the intention. Changed body/key reuse rejected.
9. Full invoice spans multiple OF and order lines: allocate complete header once, then each OF gets only its own matched amounts. Full proof sent once within each scoped result; no double count or repeated per-line full-invoice computation.
10. Partial and cumulative invoices: existing billed quantity/receipt/unit/archive/currency gates remain; unbilled remainder separate; no transport counted both from estimate and approved invoice.
11. Historical approved invoice without proof retains unknown nonzero header; zero header retains existing qualified line evidence. Corrupted/stale proof cannot establish cost. Past stored margins unchanged.
12. No physical stock change, invoice amount rewrite or CUMP entry/activation. Migration status zero. Public and HYPERBOX2 Test/Production backend version/routing verified after delivery.
13. Following UI contribution: CERP controls, preview amounts read-only, concise warnings/details, source/version frozen per intention, explicit retry after uncertain response, cache isolated by base/user/role and masked after errors. Combined screenshots pending.

Fixtures: supplier-invoice-header-allocation.test.ts and supplier-invoice.routes.test.ts; prepared NOT RUN.
