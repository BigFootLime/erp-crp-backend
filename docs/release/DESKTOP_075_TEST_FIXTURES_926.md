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

The managed browser workbench fixture now creates and links a synthetic customer
order older than 48 workshop working hours. It verifies the authoritative
calendar deadline before opening the UI. The fixture provides an explicit
weekday workshop calendar and restores the previous calendar selection during
test cleanup. The former OF-only 49-hour timestamp
predated the order-based priority rule and could no longer prove the badge.
This additional setup stays behind the existing disposable database identity
checks in `scripts/e2e/seed-workbench-sol05.cjs`.

After both source dossiers are validated through the browser, the managed
fixture prepares their raw-material needs through the canonical configuration
and confirmation repositories. A quality-released synthetic lot at one stock
location supplies the 8- and 12-unit reservations and the 3-unit consolidation
surplus. Physical
availability and reservation quantities are asserted before grouping. The
material feature flag is restored with the other fixture flags. Stock seeding
accepts the same explicitly isolated managed database boundary as OF seeding;
no consolidation guard is bypassed.

The preflight also reproduced an existing same-location merge failure:
`stock_reservations_active_need_lot_uq` rejects moving two source reservations
to one producer need, or adding surplus at that occupied location. This is
tracked separately and corrected through backend #937 / PRs #939 and #940.
The runtime correction and its migration are delivered by that separate ERP
workstream. The current managed recipe exercises the originally failing
same-location case against those integrated sources. No runtime change or
production migration is performed by the desktop publication workstream.

The margin traceability source guard follows the canonical SQL extracted by
backend #934. It checks that the repository executes those exported queries,
prices posted partial issues from their immutable consumption lines, excludes
compensated and reversed movements, and keeps missing proofs unvalued. Supplier
receipt and production declaration evidence assertions remain in place. The
former fully-consumed reservation assertion could not cover partial issues.

The #941 integration adds the persisted quote identity required by the route
fixture's real transactional cost capture, and verifies the resulting ISSUED
snapshot. Existing status, discount and audit assertions remain. Static guards
follow the extracted quote SQL and shared transaction reader: unit time uses
quote quantity once, and rate scopes are revalidated with the reader's database
connection. No quote or margin runtime is modified by these fixture repairs.
