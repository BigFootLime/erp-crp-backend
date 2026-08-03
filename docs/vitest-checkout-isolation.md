# Vitest checkout isolation

`pnpm test:run` must execute only the tests that belong to the checkout from
which the command is launched. This remains true when the checkout contains
Claude worktrees or is itself nested in a larger workspace.

## Collection contract

`vitest.config.ts` resolves its root from the config file, not from the shell's
current directory. It includes every Vitest-supported `*.test.*` and `*.spec.*`
file below `src`, including colocated domain tests below `src/module`.

The config also explicitly excludes nested tool worktrees, dependencies,
compiled output, coverage, test results, attachments, and artifact directories.
Sibling worktrees cannot enter the collection because they are outside the
resolved root; nested worktrees cannot enter because both the `src/**` include
and the worktree exclusions reject them.

Run the independent guard whenever test files or Vitest configuration changes:

```powershell
pnpm test:collection
```

The guard:

1. discovers test/spec files below `src` independently of Vitest;
2. compares that inventory with `vitest list --filesOnly`;
3. rejects duplicate, missing, non-`src`, lexical escape, and symlink escape
   paths;
4. resolves every relative TypeScript/JavaScript import below `src` and rejects
   project imports outside the checkout;
5. prints a normalized, machine-independent manifest and SHA-256 fingerprint.

`pnpm test:list` is available for a raw Vitest list. Use
`pnpm test:collection -- --json` when another tool needs structured output.

## Reproducible pnpm install

The pnpm version and dependency graph are pinned by `package.json` and
`pnpm-lock.yaml`:

```powershell
pnpm install --frozen-lockfile
pnpm test:collection
pnpm test:run
```

`pnpm-workspace.yaml` allows the required native build steps for `bcrypt` and
`esbuild` and explicitly denies the optional `@scarf/scarf` install script. Do
not bypass this policy with a blanket build-script approval.

## Filesystem and fixture isolation

Before each test file is imported, `src/__tests__/vitest.setup.ts` overrides all
writable CERP roots. The layout is unique for both the Vitest run and worker:

```text
<os-temp>/cerp-vitest/<run-uuid>/worker-<pool>-<worker>-<pid>/storage/
  documents/
  exports/
  generated/
  inbound/
  tmp/
```

Upload fixtures, document staging, as-built staging, reporting SQL dumps, and
optional PDF previews use these roots. Worker cleanup removes its own directory,
and global teardown removes the run directory even if a test leaves a fixture
behind. Tests must not override `CERP_*_ROOT` with a checkout-relative path.

Read-only repository fixtures and SQL patches use
`src/__tests__/helpers/repo-paths.ts`; they do not depend on `process.cwd()`.

## Audited collection evidence

The pre-change audit on checkout `f11707f` found 1,353 collected files:

- 60 files belonged to that checkout;
- 1,293 files came from 11 nested `.claude/worktrees` checkouts.

The delivery branch was based on the newer `dev` commit `5276a3b`, where the
checkout itself contained 162 legitimate test/spec files. The final promotion
commit `4b4e034` also includes two current-code tests added independently by
#293, bringing the legitimate total to 164. The collection guard keeps all of
them; neither 60 nor 162 is a hard-coded cap.

| Environment | Collected | Outside checkout | Manifest SHA-256 |
|---|---:|---:|---|
| Simple clone | 164 | 0 | `402dcbea2a509a6aa2b17d5707d4ea7e2d39e89362719bf70435c2de830e261a` |
| Nested `.claude/worktrees` checkout | 164 | 0 | `402dcbea2a509a6aa2b17d5707d4ea7e2d39e89362719bf70435c2de830e261a` |

The nested validation checkout contained another `.claude/worktrees` clone with
136 test/spec files. None entered the manifest. At final promotion commit
`4b4e034`, both environments completed `pnpm test:run` with 164/164 files and
3,508/3,508 tests passing. The two rows
must keep the same count and fingerprint before merging a change to the
collection rules.
