import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { repoRoot } from "./helpers/repo-paths";

type Patch = {
  filename: string;
  sql: string;
  sha256: string;
};

type RunnerModule = {
  applyPatch: (client: { query: (...args: unknown[]) => Promise<unknown> }, patch: Patch) => Promise<void>;
  buildStatuses: (
    patches: Patch[],
    applied: Map<string, { sha256: string; applied_at: Date }>
  ) => Array<Patch & { status: string }>;
  listPatches: (patchDir: string) => Array<Patch & { fullPath: string }>;
  immutableOnlyPatch: (patches: Patch[], onlyFilename: string | null) => Patch | null;
  parseArgs: (args: string[]) => {
    command: string;
    dryRun: boolean;
    check: boolean;
    patchDir: string;
    only: string | null;
  };
  runUp: (
    client: { query: (...args: unknown[]) => Promise<unknown> },
    patches: Patch[],
    options: { dryRun: boolean; only: string | null }
  ) => Promise<void>;
  sha256Sql: (sql: string) => string;
  sqlWithoutOuterTransaction: (sql: string, filename?: string) => string;
  validateImmutableInventoryPath: (patchDir: string, onlyFilename: string | null) => void;
};

const require = createRequire(import.meta.url);
const runner = require(resolve(repoRoot, "scripts/db-patches.js")) as RunnerModule;
const patchFilename = "20260804_auth_rate_limit_buckets.sql";
const planningPatchFilename = "20260805_planning_convergence_governance.sql";
const stockNavigationPatchFilename = "20260810_stock_old_new_navigation_446.sql";
const stockNavigationPatchChecksum =
  "4900f01411ab89349874fcd6d28993aa34a1ec560320d4d32b05489800bf3b9b";
const gedAntivirusPatchFilename = "20260811_ged_antivirus_quarantine.sql";
const gedAntivirusPatchChecksum =
  "7e1e026c8a16be2609f072434d1930afbd248a543d96e3b013e89426fdaa1336";
const recentSolPatchChecksums = new Map([
  [
    "20260803_admin_user_provisioning_boundary.sql",
    "c1b706a1d9ba046e63e7e0b05dfc132272bb27fccda7bd0efe8cf481ffbd5ca5",
  ],
  [
    "20260804_article_unit_stock_contract.sql",
    "cd7b4bba961e2b9783cb3046e3f3dba794b8ce68c8252377f3ecbe105007d607",
  ],
  [
    "20260809_account_invitation_activation.sql",
    "07fb4d08c4cd0bcf07abd1eb295a30db61b5d64f66d00406f4a24a4291fa4911",
  ],
  [
    "20260810_stock_movement_event_correlation.sql",
    "736887f658a39504d7cd499cd6b630e05eba0e7fcaa8ecda9f3d92083a1278be",
  ],
  [
    "20260810_system_reference_data_readiness.sql",
    "8a6bfa740ddc6e80f7b19ace948a92df379cc0df097879e9f5d125758a9f8eec",
  ],
  [
    "20260811_account_provisioning_schema_repair.sql",
    "e4a994888e3ff0dc38923a128216647f76919d4001efc70e26219742befca116",
  ],
  [
    "20260811_base_unit_drift_repair.sql",
    "53e6d11928dcd329b80fd493932aa29d2f0f65874b20a2cd1daa4e9a8847eb66",
  ],
  [
    "20260814_planning_execution_intelligence_0021.sql",
    "ca667814cae65e695ec45dccf407752432aa9e6f7e61b4d9a38ae6fcfd339107",
  ],
  [
    "20260814_sol22_quality_intelligence.sql",
    "adf2b97867ef23f9c40ecd5df7c271cd40cc4d4d67c04cc60e7444f2cf367264",
  ],
  [
    "20260814_adv_reliability_sol23.sql",
    "f14a8d356312133841168e681f4266142ff95f7e4a07dc6c2a18dd50b9a4f52e",
  ],
  [
    "20260814_project_operations_sol24.sql",
    "e978abeb2b6758744d3824540b2552ef6b6ca90f0c634bc49dd7af403d4e8cd9",
  ],
  [
    "20260814_admin_operations_sol25.sql",
    "741a16b710835f4bc05dcac52c7ba5ceb74504c962bfe4307805d2071142d3f3",
  ],
  [
    "20260814_electronic_invoicing_sol26.sql",
    "03da2f92e7c99e1ffe437fb5443517585a9c20765322d85ab0cb83e378f7968e",
  ],
  [
    "20260814_api_contract_webhooks_sol28.sql",
    "42d9f33de100499836e7c1d58ef49e91daffa4af3861c59536bc2d0ab0f87f1f",
  ],
  [
    "20260814_client_portal_sol29.sql",
    "d5c203c1c44f61b2b296d8fd08a5a35eb8b65060200119cbf7fe873f215d0f5c",
  ],
  [
    "20260814_identification_labels_sol30.sql",
    "e9a2a116945105fbcce2a4ecc7246b3c9708a9d64920ed5f7a8ef94dc3740a7d",
  ],
]);
const wave9PatchChecksums = new Map([
  [
    "20260216_planning_visuals_programmation.sql",
    "e220d040caae9b18bb42d3c970104b2d2612bce53dac6b43c4aac60268491a1b",
  ],
  [
    "20260804_finance_settlement_state_469.sql",
    "55e8cb8304d71e790056111e6452b8825fc5349b88976bd0eea281359da543d5",
  ],
  [
    "20260805_programmation_safe_reschedule_0004.sql",
    "341f7911a7bcb479fce6602d0567c51d47f083a08b37409e55d05cf3110f01b5",
  ],
  [
    "20260805_quality_delivery_release_gate_0005.sql",
    "ceff91b88820e9943d199f71a73e32fd4f994d383f76aabb620ea648c9d1ae53",
  ],
  [
    "20260805_station_offline_queue_0006.sql",
    "3e223c43698bdf3399ab2d37e6493d0d014952eb0fe877cdeb1c4b4f7f7db3da",
  ],
]);

function queryText(value: unknown): string {
  return String(value).replace(/\s+/g, " ").trim();
}

function transactionalClient(failure?: "patch" | "registry") {
  const committed = { patchObject: false, registryEntry: false };
  let pending = { ...committed };
  let inTransaction = false;

  const query = vi.fn(async (sql: unknown) => {
    const statement = queryText(sql);
    if (statement === "BEGIN") {
      inTransaction = true;
      pending = { ...committed };
    } else if (statement.includes("CREATE TABLE example")) {
      if (failure === "patch") throw new Error("patch failed");
      pending.patchObject = true;
    } else if (statement.includes("INSERT INTO public.cerp_schema_migrations")) {
      if (failure === "registry") throw new Error("registry failed");
      pending.registryEntry = true;
    } else if (statement === "COMMIT") {
      Object.assign(committed, pending);
      inTransaction = false;
    } else if (statement === "ROLLBACK") {
      pending = { ...committed };
      inTransaction = false;
    }
    return { rows: [] };
  });

  return { committed, isInTransaction: () => inTransaction, query };
}

function inventoryClient(appliedRows: Array<{ filename: string; sha256: string; applied_at: Date }> = []) {
  const query = vi.fn(async (sql: unknown) => {
    const statement = queryText(sql);
    if (statement.includes("SELECT to_regclass($1) IS NOT NULL AS exists")) {
      return { rows: [{ exists: true }] };
    }
    if (statement.includes("SELECT filename, sha256, applied_at")) {
      return { rows: appliedRows };
    }
    return { rows: [] };
  });
  return { query };
}

describe("database patch runner", () => {
  it("uses the same deterministic LF checksum on Windows and Linux checkouts", () => {
    const lf = "BEGIN;\nSELECT 'rate-limit';\nCOMMIT;\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(runner.sha256Sql(crlf)).toBe(runner.sha256Sql(lf));

    const patch = readFileSync(resolve(repoRoot, "db/patches", patchFilename), "utf8");
    expect(runner.sha256Sql(patch)).toBe(
      "f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2"
    );

    const planningPatch = readFileSync(resolve(repoRoot, "db/patches", planningPatchFilename), "utf8");
    expect(runner.sha256Sql(planningPatch)).toBe(
      "4ac0aa05dc489ae5f882491e7b41cc6e96ac3bcaabd554ecddfb82d6580734dc"
    );

    const stockNavigationPatch = readFileSync(
      resolve(repoRoot, "db/patches", stockNavigationPatchFilename),
      "utf8"
    );
    expect(runner.sha256Sql(stockNavigationPatch)).toBe(stockNavigationPatchChecksum);

    const gedAntivirusPatch = readFileSync(
      resolve(repoRoot, "db/patches", gedAntivirusPatchFilename),
      "utf8"
    );
    expect(runner.sha256Sql(gedAntivirusPatch)).toBe(gedAntivirusPatchChecksum);

    for (const [filename, checksum] of recentSolPatchChecksums) {
      const sql = readFileSync(resolve(repoRoot, "db/patches", filename), "utf8");
      expect(runner.sha256Sql(sql)).toBe(checksum);
    }

    for (const [filename, checksum] of wave9PatchChecksums) {
      const sql = readFileSync(resolve(repoRoot, "db/patches", filename), "utf8");
      expect(runner.sha256Sql(sql)).toBe(checksum);
    }

    const previouslyRecordedPatch = readFileSync(
      resolve(repoRoot, "db/patches/20260731_stock_old_new_446.sql"),
      "utf8"
    );
    expect(runner.sha256Sql(previouslyRecordedPatch)).toBe(
      "624bb347dfd0458b913cad1fe25affc71ef0bdf3a2a1e2c9250f6f10589af794"
    );
  });

  it("binds --only to one exact basename and canonical LF checksum", () => {
    const patches = runner.listPatches(resolve(repoRoot, "db/patches"));
    const selected = runner.immutableOnlyPatch(patches, patchFilename);

    expect(selected).toMatchObject({
      filename: patchFilename,
      sha256: "f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2",
    });
    expect(runner.immutableOnlyPatch(patches, planningPatchFilename)).toMatchObject({
      filename: planningPatchFilename,
      sha256: "4ac0aa05dc489ae5f882491e7b41cc6e96ac3bcaabd554ecddfb82d6580734dc",
    });
    expect(runner.parseArgs(["up", "--only", planningPatchFilename]).only).toBe(
      planningPatchFilename
    );
    expect(runner.immutableOnlyPatch(patches, stockNavigationPatchFilename)).toMatchObject({
      filename: stockNavigationPatchFilename,
      sha256: stockNavigationPatchChecksum,
    });
    expect(runner.parseArgs(["up", "--only", stockNavigationPatchFilename]).only).toBe(
      stockNavigationPatchFilename
    );
    expect(runner.immutableOnlyPatch(patches, gedAntivirusPatchFilename)).toMatchObject({
      filename: gedAntivirusPatchFilename,
      sha256: gedAntivirusPatchChecksum,
    });
    expect(runner.parseArgs(["up", "--only", gedAntivirusPatchFilename]).only).toBe(
      gedAntivirusPatchFilename
    );
    for (const [filename, checksum] of recentSolPatchChecksums) {
      expect(runner.immutableOnlyPatch(patches, filename)).toMatchObject({
        filename,
        sha256: checksum,
      });
      expect(runner.parseArgs(["up", "--only", filename]).only).toBe(filename);
    }
    for (const [filename, checksum] of wave9PatchChecksums) {
      expect(runner.immutableOnlyPatch(patches, filename)).toMatchObject({
        filename,
        sha256: checksum,
      });
      expect(runner.parseArgs(["up", "--only", filename]).only).toBe(filename);
    }
    expect(runner.parseArgs(["up", "--only", patchFilename]).only).toBe(patchFilename);
    expect(() => runner.parseArgs(["up", "--only", `db/patches/${patchFilename}`])).toThrow(
      /exact patch basename/
    );
    expect(() => runner.parseArgs(["up", "--only", patchFilename.toUpperCase()])).toThrow(
      /not registered as an immutable patch selection/
    );
    expect(() => runner.parseArgs(["up", "--only"])).toThrow(/exact patch basename/);
    expect(() => runner.parseArgs(["baseline", "--only", patchFilename])).toThrow(
      /not supported for metadata-only baseline/
    );
    expect(() =>
      runner.immutableOnlyPatch(
        [{ filename: patchFilename, sql: "SELECT 1;", sha256: runner.sha256Sql("SELECT 1;") }],
        patchFilename
      )
    ).toThrow(/expected canonical LF SHA-256/);
  });

  it("refuses an alternate --patch-dir that could hide the global inventory", () => {
    const targetOnlyDirectory = resolve(repoRoot, "tmp/target-only");

    expect(() =>
      runner.parseArgs([
        "up",
        "--only",
        patchFilename,
        "--patch-dir",
        targetOnlyDirectory,
      ])
    ).toThrow(/cannot be combined with --patch-dir/);
    expect(() =>
      runner.parseArgs([
        "up",
        `--only=${patchFilename}`,
        `--patch-dir=${resolve(repoRoot, "db/patches")}`,
      ])
    ).toThrow(/cannot be combined with --patch-dir/);
    expect(() =>
      runner.validateImmutableInventoryPath(targetOnlyDirectory, patchFilename)
    ).toThrow(/canonical db\/patches inventory/);
    expect(() =>
      runner.validateImmutableInventoryPath(resolve(repoRoot, "db/patches"), patchFilename)
    ).not.toThrow();
  });

  it("applies only the immutable target while leaving another global patch pending", async () => {
    const target = runner.immutableOnlyPatch(
      runner.listPatches(resolve(repoRoot, "db/patches")),
      patchFilename
    )!;
    const otherSql = "BEGIN;\nSELECT 'OTHER_PENDING_PATCH';\nCOMMIT;\n";
    const other = {
      filename: "20260803_other_pending.sql",
      sql: otherSql,
      sha256: runner.sha256Sql(otherSql),
    };
    const client = inventoryClient();

    await runner.runUp(
      { query: client.query },
      [other, target],
      { dryRun: false, only: patchFilename }
    );

    const statements = client.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.includes("CREATE TABLE public.auth_rate_limit_buckets"))).toBe(true);
    expect(statements.some((statement) => statement.includes("OTHER_PENDING_PATCH"))).toBe(false);
    const registryCall = client.query.mock.calls.find(([statement]) =>
      String(statement).includes("INSERT INTO public.cerp_schema_migrations")
    );
    expect(registryCall?.[1]).toEqual([patchFilename, target.sha256]);
  });

  it("treats an applied --only target as a no-op while another patch remains pending", async () => {
    const target = runner.immutableOnlyPatch(
      runner.listPatches(resolve(repoRoot, "db/patches")),
      patchFilename
    )!;
    const otherSql = "SELECT 'STILL_PENDING';\n";
    const other = {
      filename: "20260803_other_pending.sql",
      sql: otherSql,
      sha256: runner.sha256Sql(otherSql),
    };
    const client = inventoryClient([
      { filename: target.filename, sha256: target.sha256, applied_at: new Date(0) },
    ]);

    await runner.runUp(
      { query: client.query },
      [other, target],
      { dryRun: false, only: patchFilename }
    );

    const statements = client.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.includes("auth_rate_limit_buckets"))).toBe(false);
    expect(statements.some((statement) => statement.includes("STILL_PENDING"))).toBe(false);
    expect(statements.some((statement) => statement.includes("INSERT INTO"))).toBe(false);
  });

  it("refuses --only when any other applied inventory checksum mismatches", async () => {
    const target = runner.immutableOnlyPatch(
      runner.listPatches(resolve(repoRoot, "db/patches")),
      patchFilename
    )!;
    const otherSql = "SELECT 'GLOBAL_CHECKSUM';\n";
    const other = {
      filename: "20260803_other_applied.sql",
      sql: otherSql,
      sha256: runner.sha256Sql(otherSql),
    };
    const client = inventoryClient([
      { filename: other.filename, sha256: "0".repeat(64), applied_at: new Date(0) },
    ]);

    await expect(
      runner.runUp(
        { query: client.query },
        [other, target],
        { dryRun: false, only: patchFilename }
      )
    ).rejects.toThrow(/one or more applied files changed checksum/);

    const statements = client.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) => statement.includes("CREATE TABLE public.auth_rate_limit_buckets"))).toBe(false);
  });

  it("accepts every tracked primary patch transaction shape", () => {
    const patches = runner.listPatches(resolve(repoRoot, "db/patches"));
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) {
      expect(() => runner.sqlWithoutOuterTransaction(patch.sql, patch.filename)).not.toThrow();
      expect(patch.sql).not.toMatch(
        /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY|VACUUM|REINDEX\s+(?:DATABASE|SYSTEM)|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM)\b/i
      );
    }
  });

  it("supports BOM and commented wrappers without mistaking comments or a DO block for controls", () => {
    const wrapped = [
      " \t\n\uFEFF/* header /* nested block comment */ still header */",
      "START TRANSACTION /* runner wrapper */; -- removed before execution",
      "SELECT 1;",
      "COMMIT WORK /* runner commits after the registry insert */;",
      "",
    ].join("\n");
    const executable = runner.sqlWithoutOuterTransaction(wrapped, "commented.sql");
    expect(executable).toContain("SELECT 1;");
    expect(executable).not.toMatch(/\b(?:START\s+TRANSACTION|COMMIT\s+WORK)\b/i);
    expect(executable).not.toContain("\uFEFF");

    const unwrappedDoBlock = [
      "/* COMMIT; is only a comment. */",
      "DO $body$",
      "BEGIN",
      "  PERFORM 'ROLLBACK;';",
      "END",
      "$body$;",
      "",
    ].join("\n");
    expect(runner.sqlWithoutOuterTransaction(unwrappedDoBlock, "do-block.sql")).toBe(
      unwrappedDoBlock
    );
  });

  it("cannot hide top-level controls behind PostgreSQL standard strings or quoted identifiers", () => {
    expect(() =>
      runner.sqlWithoutOuterTransaction(
        String.raw`SELECT '\'; COMMIT; SELECT 1;`,
        "standard-string-bypass.sql"
      )
    ).toThrow(/unsupported transaction control/);

    expect(() =>
      runner.sqlWithoutOuterTransaction(
        String.raw`SELECT "\"; ROLLBACK; SELECT 1;`,
        "quoted-identifier-bypass.sql"
      )
    ).toThrow(/unsupported transaction control/);
  });

  it("does not mistake dollar signs inside PostgreSQL identifiers for dollar quotes", () => {
    expect(() =>
      runner.sqlWithoutOuterTransaction(
        "SELECT 1 AS first$tag$; COMMIT; SELECT 1 AS second$tag$;",
        "dollar-identifier-bypass.sql"
      )
    ).toThrow(/unsupported transaction control/);
  });

  it("keeps backslash quote escapes inside explicit PostgreSQL E strings", () => {
    const sql = String.raw`SELECT E'not top-level: \'; COMMIT;'; SELECT 1;`;
    expect(runner.sqlWithoutOuterTransaction(sql, "escape-string.sql")).toBe(sql);
  });

  it.each([
    "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;\nSELECT 1;\nCOMMIT;\n",
    "START TRANSACTION READ ONLY;\nSELECT 1;\nCOMMIT;\n",
    "SELECT 1;\nCOMMIT AND CHAIN;\n",
    "SAVEPOINT future_control;\nSELECT 1;\n",
    "ROLLBACK TO SAVEPOINT future_control;\n",
    "PREPARE TRANSACTION 'future-control';\n",
  ])("refuses unsupported top-level transaction control: %s", (sql) => {
    expect(() => runner.sqlWithoutOuterTransaction(sql, "unsupported.sql")).toThrow(
      /unsupported transaction control/
    );
  });

  it("commits the patch and its complete registry record in one runner-owned transaction", async () => {
    const client = transactionalClient();
    const sql = "-- wrapped patch\r\nBEGIN;\r\nCREATE TABLE example(id integer);\r\nCOMMIT;\r\n";
    const patch = { filename: patchFilename, sql, sha256: runner.sha256Sql(sql) };

    await runner.applyPatch({ query: client.query }, patch);

    expect(client.query).toHaveBeenCalledTimes(6);
    expect(client.query.mock.calls[0][0]).toBe("BEGIN");
    expect(queryText(client.query.mock.calls[1][0])).toContain(
      "SELECT pg_advisory_xact_lock(hashtext($1))"
    );
    expect(client.query.mock.calls[1][1]).toEqual(["cerp_schema_migrations"]);
    expect(client.query.mock.calls[2][0]).toBe(
      "SET LOCAL standard_conforming_strings = on"
    );
    expect(queryText(client.query.mock.calls[3][0])).toContain("CREATE TABLE example(id integer);");
    expect(queryText(client.query.mock.calls[3][0])).not.toMatch(/\b(?:BEGIN|COMMIT)\s*;/i);
    expect(queryText(client.query.mock.calls[4][0])).toContain(
      "INSERT INTO public.cerp_schema_migrations (filename, sha256, applied_at)"
    );
    expect(queryText(client.query.mock.calls[4][0])).toContain("statement_timestamp()");
    expect(client.query.mock.calls[4][1]).toEqual([patch.filename, patch.sha256]);
    expect(client.query.mock.calls[5][0]).toBe("COMMIT");
    expect(client.committed).toEqual({ patchObject: true, registryEntry: true });
    expect(client.isInTransaction()).toBe(false);
  });

  it.each(["patch", "registry"] as const)(
    "rolls back without a patch object or registry entry when the %s write fails",
    async (failure) => {
      const client = transactionalClient(failure);
      const sql = "BEGIN;\nCREATE TABLE example(id integer);\nCOMMIT;\n";

      await expect(
        runner.applyPatch(
          { query: client.query },
          { filename: patchFilename, sql, sha256: runner.sha256Sql(sql) }
        )
      ).rejects.toThrow(`${failure} failed`);

      const statements = client.query.mock.calls.map(([statement]) => queryText(statement));
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      if (failure === "patch") {
        expect(statements.some((statement) => statement.includes("INSERT INTO"))).toBe(false);
      }
      expect(client.committed).toEqual({ patchObject: false, registryEntry: false });
      expect(client.isInTransaction()).toBe(false);
    }
  );

  it("skips a matching registered patch and rejects unsafe transaction control", () => {
    const patch = {
      filename: patchFilename,
      sql: "SELECT 1;\n",
      sha256: runner.sha256Sql("SELECT 1;\n"),
    };
    const statuses = runner.buildStatuses(
      [patch],
      new Map([[patch.filename, { sha256: patch.sha256, applied_at: new Date(0) }]])
    );

    expect(statuses).toMatchObject([{ filename: patch.filename, status: "applied" }]);
    expect(() =>
      runner.sqlWithoutOuterTransaction("BEGIN;\nSELECT 1;\n", "unsafe.sql")
    ).toThrow(/unsupported transaction control/);
  });
});
