# Legacy metrology import

Issue #1460 / frontend #1780. This is an operator command for a reviewed, private
source inventory. The HTTP API cannot stage equipment facts or source hashes.
Original workbooks and scans must remain read-only.

The import retains each source path, SHA-256, size and original file. Identical
content at different paths remains distinct documentary evidence. Copies use
content addresses below the normal metrology document root and require an
actual enforced antivirus scan. An unavailable scanner stops staging.

The reviewed semantic sidecar distinguishes apparatus identities, references
used as standards, real historical observations, raw sheet evidence and files
whose target requires review. Original dates, visas, values, formulas, headers,
merged-cell information and source coordinates remain available. Legacy
observations do not create signed CERP executions or qualifying verdicts.

## Commands

Build the backend before --stage or --apply. Supply the usual runtime
environment through the deployment operator; never put database credentials in
command arguments or receipts.

~~~sh
node scripts/metrology/import-legacy-metrology.mjs \
  --dry-run --manifest /private/manifest.json --semantics /private/semantics.json \
  --source-root /private/read-only-source --receipt /private/dry-run.receipt.json

node scripts/metrology/import-legacy-metrology.mjs \
  --stage --manifest /private/manifest.json --semantics /private/semantics.json \
  --source-root /private/read-only-source \
  --expected-database cerp_test --actor-user-id EXISTING_USER_ID \
  --receipt /private/stage.receipt.json

node scripts/metrology/import-legacy-metrology.mjs \
  --apply --batch-id STAGED_BATCH_UUID \
  --expected-source-set-sha256 REVIEWED_DIGEST \
  --expected-database cerp_test --actor-user-id EXISTING_USER_ID \
  --receipt /private/apply.receipt.json
~~~

--dry-run verifies every source file without a database connection, copy or
antivirus claim. Staging and applying require an explicit matching database and
an existing actor in that database. Business imports into a template database
are refused. Apply locks the staged batch, refuses existing equipment
collisions and commits all business facts together. Repeating the same batch
returns its existing result.

Apply the two registered additive patches selectively, with their preflight
and verification SQL. Source facts and observations are immutable. The guarded
rollback is only available before evidence has been staged. After an import,
recovery uses the verified pre-import backup and the release recovery plan.

Complete an isolated PostgreSQL rehearsal, then common-Test import and real
interface checks before the separately coordinated production delivery.
Production requires a fresh verified backup. The managed template receives
schema changes only.

## Local tests

~~~sh
node --test scripts/metrology/legacy-import-files.test.mjs \
  scripts/metrology/legacy-import-plan.test.mjs \
  scripts/metrology/legacy-import-stage.test.mjs
pnpm exec vitest run metrolog --config vitest.config.ts --maxWorkers=2
pnpm run build
~~~

These focused tests complement the PostgreSQL rehearsal, canonical release
qualification and interface verification. Test fixtures contain synthetic data;
private manifests and originals must never be committed.
