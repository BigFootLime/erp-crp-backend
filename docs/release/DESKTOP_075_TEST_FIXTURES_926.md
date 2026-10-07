# Desktop 0.1.75 backend validation fixtures — #926

The mandatory desktop release gate identified test fixtures that predated the
current account-recovery, supplier qualification, authoritative PDF and material
purchase contracts. This change updates only test setup and assertions. No API,
migration, dependency or backend deployment is included.

The SQL fixtures now provide the active account and revalidated badge required
before a station session is committed, the supplier qualification header and
open-contract scope, and the archived general-terms reader used by order PDFs.
The PDF uniqueness race is raised only for the archive insert. Material fixtures
preserve stock, future supply and yield quantities and explicitly acknowledge
existing purchases. Maintenance success cases include their controls and first
due date. Three domain files use the repository's Vitest runner so their existing
assertions are included in the complete collection.

Negative assertions continue to reject revoked devices, recovering accounts,
unreviewed existing purchases and incomplete maintenance plans. Transaction,
permission, quantity and idempotency assertions remain in place. No runtime
guard is disabled and no test is skipped to obtain a release verdict.

Linux validation uses an unprivileged user in the isolated desktop runner. A
root-owned world-writable temporary ancestor is correctly rejected by the
private-upload guards; the runner must exercise the same ownership boundary as
the application service.

Validation evidence is recorded in the pull request and the archived desktop
release reports: checkout-local collection, targeted tests, the complete backend
suite and TypeScript build, followed by the candidate and final production
unified release gates. Initial failed reports are retained. A gate pass alone
does not establish that the Electron update feed has been published.

Related frontend delivery: BigFootLime/crp-systems-web#1192 and PR #1201.
