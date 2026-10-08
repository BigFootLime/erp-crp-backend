# Final common acceptance — material invoice confirmation

Status: **NOT RUN**. No actual financial confirmation or CUMP activation during development. Run in Base Test as part of the final combined recipe, after a documented opening/reconciliation and controlled activation.

1. Approved archived EUR invoice, one complete company lot: exact variance, remaining Stock share and consumed residual; no amount input.
2. Same article/unit across several lots: one quantity-neutral Stock transition and exact sum of lot deltas. Different articles/units remain separate.
3. Exhausted lot and known zero balance: no physical stock recreated; consumed variance remains exact.
4. Signed discount and a twelve-decimal residual: cumulative deterministic allocation, no lost cent or residual.
5. Unknown original receipt price, opening/shared/mixed lot, missing journal, partial invoice, credit/client stock/unit or currency mismatch: explained refusal and zero financial writes.
6. Concurrent receipt, issue, invoice/archive edit or projector advance after GET: source mismatch/refresh or bounded 409, no stale correction.
7. Concurrent identical UUID: one parent/audit/entry set, replayed immutable response. Changed actor/body or second UUID for an applied invoice: conflict, no duplicate.
8. Drop one child, alter entry/balance identity, introduce wrong arithmetic or directly mutate/truncate ledger: guard refuses and transaction rolls back.
9. Full prior decimal representation is preserved; known positive Stock is quantity-neutral, negative resulting value refused.
10. Finance reader/module-grant user denied POST; authorized financial role plus approval capability succeeds. Cross-base/session UI cache and intention scope stay isolated.
11. Proved OF consumption versus unrelated consumption: distinct physical line/OF versus explicit unassigned amount; no guessed OF.
12. New explicit margin computation includes only proved consumed variance. Old margin snapshots and original Stock costs remain unchanged. Later return is explained unresolved until its allocation policy is available.
13. Lost response/manual retry: same source/method/UUID/body retained; no automatic POST, user refresh creates a new confirmation intent.
14. Budget/timeouts and concurrent fiscal locks: bounded retryable error before proxy timeout, no lingering transaction.
15. Rollback before real use restores original entry checks without deleting evidence; after real correction it refuses destructive rollback and requires a forward correction.

Capture actor/base, source SHA, invoice/receipt/lot/entry/physical-line IDs, exact before/after values, audit, request UUID and screenshots. Prepared colocated financial fixtures are not substitutes for this end-to-end acceptance.
