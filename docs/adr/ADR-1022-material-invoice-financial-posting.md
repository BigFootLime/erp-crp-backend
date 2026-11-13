# ADR-1022 — Explicit sourced material invoice correction

An approved late material invoice can differ from the cost frozen at receipt. The #1019 proposal is read-only. A separate protected Finance confirmation now appends its signed variance without accepting an HTTP amount or replacing old issue/margin records.

The intent contains invoice UUID, named allocation method, full observed-source SHA and request UUID. Same actor and intent replay the immutable response before current-stock checks; different intent conflicts. A unique invoice ledger prevents a second application. Finance approval and the existing financial `snapshot` role are both required; a module/read grant never confers financial write rights.

The writer serializes projector control, the journal commit barrier, invoice and fiscal evidence. GET, POST and the parent guard use the same bounded SQL source. Sources are re-read under locks; approval/archive, receipt baseline, physical lot trace, current balance or units changing require refresh. The SQL guard independently checks fiscal-cent allocation and twelve-decimal lot/consumption arithmetic. Existing #983/#1007 guard function bodies are preserved.

One company/EUR/article/unit transition changes value only. The dedicated invoice candidate admits a reconciled zero quantity/value while the existing manual positive-stock correction is unchanged. Unknown or negative resulting value fails. Consumed variance is allocated with exact residuals to immutable physical lines; an OF is assigned only where that journal proves it. Other consumption remains visibly unassigned. Deferred guards require the exact parent, all entries, balances and consumed children at commit. Audit is in the same transaction.

Only future explicitly computed margin versions include a proved consumed correction. Existing issue values and margin snapshots remain intact. A later return after such a correction is explained UNKNOWN pending an explicit return-allocation policy; it must not retain a full consumed surcharge on returned stock. Multi-line ambiguous issue roots retain the existing unresolved policy.

Initial policy excludes credits, partial invoices, old/opening or mixed/shared lots, client ownership and missing capture/baseline. No historic price is inferred. CUMP remains PREPARED until final common acceptance; this delivery neither activates it nor performs a real financial confirmation. No external AI or new dependency.

Validation: strict types/build/OpenAPI and real-schema SQL PREPARE/EXPLAIN without ANALYZE, DDL/verify/rollback in ROLLBACK on Test/Prod. Business, UI, RBAC, financial, concurrency and combined acceptance fixtures are prepared **NOT RUN** at the human's request. Source SHA changes with the new canonical SQL representation; users must refresh any old preview after deployment.
