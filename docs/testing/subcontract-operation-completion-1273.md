# External operation completion (#1273)

Receipt, current quality release, origin transfers and dossier closure are separate facts. The last normal dossier closure now records immutable external completion evidence and sets the canonical operation to DONE when the entire OF population is returned, conforming and transferred. Multiple material origins remain distinct.

The evidence supplies operation quantities to readiness and planning. It creates no local machining declaration, timer, finished-goods stock, recovery OF, or change to customer dates. Existing local declarations require review and are never overwritten or added to external counts. Later quality holds still reduce downstream availability through the existing current-quality gate.

Partial returns, open dossiers, cancellations with custody, unmatched historical returns, quality holds and permanently rejected quantities cannot satisfy this full conforming completion path. Their existing decisions and explicit loss workflow remain separate; no loss is inferred from partial progress. Completion of a partial population after definitive upstream loss remains a separate case to qualify.

Before deployment, rehearse the additive patch twice on an isolated restored database. Verify the real two-origin transfer/closure route, its intermediate state and retry handling, quality hold, inactive revision, legacy output, immutable evidence and zero extra stock/pointage/recovery. Run the verify SQL and strict build.

Already closed dossiers are repaired with the same service, not a blanket status update:

    node scripts/subcontract/reconcile-completed-operations.cjs --database=cerp_test --actor-user-id=<existing-authorized-id>
    node scripts/subcontract/reconcile-completed-operations.cjs --database=cerp_test --actor-user-id=<existing-authorized-id> --apply

The default dry-run rolls back evidence, status and audit. Apply only after a fresh verified VPS backup, with the target database verified. Prod requires explicit --allow-prod and runs against its own canonical data; never copy Test records.

If source is rolled back after evidence has been recorded, retain the additive schema and history. The rollback SQL refuses to drop a populated evidence table.

Status: 78 focused checks and strict build pass. The restored PostgreSQL/HTTP rehearsal passes16 checks, including partial18 then complete20, current quality hold, legacy output, immutable evidence, rollback-only repair and zero new stock/pointage/recovery. Apply-twice and schema verification pass; the owned fixture database is removed. The failed audit-author rehearsal is retained, and repair now requires an explicit existing actor. Live deployment and actual recipe replay remain pending.
