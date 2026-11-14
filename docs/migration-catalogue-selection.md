# Migration selection and applicability catalogue (#1523)

An isolated migration run executes one selected SQL file at a time. Applicability
guards still need the full catalogue owned by that selection, including the exact
checksums of prerequisites already recorded in the ledger. `--patch-dir` selects
the SQL files; `--inventory-dir` supplies that catalogue. Every selected filename
and checksum must match it before a database connection is opened.

Without the new option, catalogue and selection remain identical. `--only`
continues to require the canonical inventory and refuses either directory override.
Status, application and baseline recording still operate only on the selection.
The catalogue does not execute prerequisites or add ledger rows.

The isolated runner passes its actual `patchDir`: canonical `db/patches` or the
separate `db/test-only-patches`. This replaces the metrology-only copied-file
exception with the same rule for all guards. SQL, immutable hashes, ledger/profile
checks and migration order are unchanged.

The previous workaround comment is retained here as historical context; the
general catalogue option now supplies this inventory without copying prerequisites:

```js
// The closed metrology seed is assessed against the exact Finance GED profile.
// `db-patches` must therefore see its immutable prerequisite checksums even
// though this isolated runner applies one patch at a time from a temporary
// directory. These files have all been applied before the closed seed under
// the canonical dependency order; copying them here exposes the inventory, it
// does not re-order or re-run them.
```

Regression checks cover default/explicit catalogue selection, checksum and missing
member refusal, incomplete metrology prerequisites, `--only` restrictions and the
actual isolated `runPatch` function with canonical and test-only catalogues,
including cleanup on a failing child process. Reconstructed CRP and EC historical
code also pass 31 authenticated material/MFA checks each against disposable local
fixtures using the pinned historical adapter of this fix. That acceptance does
not establish equivalence of private production configuration or migration ledgers.
