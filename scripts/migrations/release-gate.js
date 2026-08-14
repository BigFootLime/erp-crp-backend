#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const PATCH_DIR = path.join(ROOT, "db", "patches");
const SUPPORT_DIR = path.join(PATCH_DIR, "support");
const SOL06_PATCH = "20260810_system_reference_data_readiness.sql";
const PRODUCTION_READINESS_PATCH = "20260811_production_readiness_center.sql";
const MARGIN_TRACEABILITY_PATCH = "20260811_margin_traceability_0002.sql";
const COMMERCIAL_RELIABILITY_PATCH = "20260812_commercial_reliability_sol17.sql";
const PROCUREMENT_RELIABILITY_PATCH = "20260812_procurement_reliability_sol18.sql";
const STOCK_INTELLIGENCE_PATCH = "20260813_stock_intelligence_sol19.sql";
const TOOLING_TECHNICAL_GED_PATCH = "20260813_sol20_tooling_technical_ged.sql";
const PLANNING_EXECUTION_PATCH = "20260814_planning_execution_intelligence_0021.sql";
const SOL06_SUPPORT = path.join(SUPPORT_DIR, "20260810_system_reference_data_readiness");
const POSTGRES_IMAGE = "postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229";
const DEFAULT_REPORT_DIR = path.join(ROOT, "docs", "release");

function databaseClient(options) {
  const { Client } = require("pg");
  return new Client(options);
}

function fail(message) {
  throw new Error(`[SOL-06 migration gate] ${message}`);
}

function normalizedSql(content) {
  return content.replace(/\r\n/g, "\n");
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function orderedPatches() {
  return fs.readdirSync(PATCH_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((left, right) => {
      const a = left.slice(0, -4);
      const b = right.slice(0, -4);
      if (b.startsWith(`${a}_`)) return -1;
      if (a.startsWith(`${b}_`)) return 1;
      return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
    });
}

function expectedRehearsalPatches() {
  const patches = orderedPatches();
  const start = patches.indexOf(SOL06_PATCH);
  if (start < 0) fail(`canonical patch ${SOL06_PATCH} is missing`);
  return patches.slice(start);
}

function inventory() {
  const patches = orderedPatches().map((filename, index) => {
    const sql = normalizedSql(fs.readFileSync(path.join(PATCH_DIR, filename), "utf8"));
    const base = filename.slice(0, -4);
    const support = {
      preflight: fs.existsSync(path.join(SUPPORT_DIR, `${base}.preflight.sql`)),
      verify: fs.existsSync(path.join(SUPPORT_DIR, `${base}.verify.sql`)),
      rollback: fs.existsSync(path.join(SUPPORT_DIR, `${base}.rollback.sql`)),
    };
    const risks = [];
    if (/\bDROP\s+(TABLE|COLUMN|TYPE|SCHEMA)\b/i.test(sql)) risks.push("destructive-ddl");
    if (/\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(sql)) risks.push("destructive-dml");
    if (/\bUPDATE\s+(public\.)?/i.test(sql)) risks.push("data-rewrite");
    if (/\bALTER\s+TABLE\b/i.test(sql)) risks.push("table-lock");
    if (/\bCREATE\s+(UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/i.test(sql)) risks.push("blocking-index");
    if (/\bALTER\s+TYPE\b/i.test(sql)) risks.push("enum-change");
    return {
      order: index + 1,
      filename,
      sha256: sha256(sql),
      bytes: Buffer.byteLength(sql),
      transaction_wrapped: /^\s*BEGIN\s*;/im.test(sql) && /COMMIT\s*;\s*$/im.test(sql),
      replay_markers: /IF\s+NOT\s+EXISTS|CREATE\s+OR\s+REPLACE|ON\s+CONFLICT|DROP\s+\w+\s+IF\s+EXISTS/i.test(sql),
      support,
      risks: [...new Set(risks)],
    };
  });
  const supportFiles = fs.readdirSync(SUPPORT_DIR).filter((name) => name.endsWith(".sql"));
  const recent = patches.filter((patch) => patch.filename >= "20260701");
  return {
    generated_at: new Date().toISOString(),
    source: "filesystem scan of db/patches and db/patches/support",
    patch_count: patches.length,
    support_file_count: supportFiles.length,
    recent_patch_count: recent.length,
    recent_support_gaps: recent
      .filter((patch) => !patch.support.preflight || !patch.support.verify || !patch.support.rollback)
      .map((patch) => ({ filename: patch.filename, support: patch.support })),
    risk_totals: {
      destructive_ddl: patches.filter((patch) => patch.risks.includes("destructive-ddl")).length,
      destructive_dml: patches.filter((patch) => patch.risks.includes("destructive-dml")).length,
      data_rewrite: patches.filter((patch) => patch.risks.includes("data-rewrite")).length,
      table_lock: patches.filter((patch) => patch.risks.includes("table-lock")).length,
      blocking_index: patches.filter((patch) => patch.risks.includes("blocking-index")).length,
      enum_change: patches.filter((patch) => patch.risks.includes("enum-change")).length,
    },
    patches,
  };
}

function inventoryMarkdown(report) {
  const gaps = report.recent_support_gaps.length
    ? report.recent_support_gaps.map((gap) => `- \`${gap.filename}\`: preflight=${gap.support.preflight}, verify=${gap.support.verify}, rollback=${gap.support.rollback}`).join("\n")
    : "- Aucun écart sur la période récente.";
  return `# Inventaire des migrations — SOL-06

- Généré : ${report.generated_at}
- Source : ${report.source}
- Patches exécutables : ${report.patch_count}
- Scripts auxiliaires : ${report.support_file_count}
- Patches depuis 2026-07-01 : ${report.recent_patch_count}

## Risques statiques à examiner

| Classe | Nombre de patches |
|---|---:|
| DDL destructif | ${report.risk_totals.destructive_ddl} |
| DML destructif | ${report.risk_totals.destructive_dml} |
| Réécriture de données | ${report.risk_totals.data_rewrite} |
| Verrou de table possible | ${report.risk_totals.table_lock} |
| Index non concurrent | ${report.risk_totals.blocking_index} |
| Évolution d'enum | ${report.risk_totals.enum_change} |

Ces détections sont volontairement conservatrices : elles servent de file de revue, pas de preuve de danger. Les durées réelles sont capturées par la répétition isolée.

## Couverture auxiliaire récente incomplète

${gaps}

Le détail machine, l'ordre, les SHA-256, la transaction, la rejouabilité et les risques par fichier sont dans \`MIGRATION_INVENTORY_SOL_06.json\`.
`;
}

function writeInventory(reportDir = DEFAULT_REPORT_DIR) {
  const report = inventory();
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, "MIGRATION_INVENTORY_SOL_06.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDir, "MIGRATION_INVENTORY_SOL_06.md"), inventoryMarkdown(report));
  return report;
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    options[key] = inline ?? args[++index];
  }
  return options;
}

function assertDatabaseTarget(rawUrl, allowRemoteReadOnly = false) {
  if (!rawUrl) fail("DATABASE_URL is required");
  const url = new URL(rawUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) fail("PostgreSQL DATABASE_URL required");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const productionLike = /(^|[_-])(prod|production)([_-]|$)/i.test(url.pathname.slice(1));
  if ((!loopback || productionLike) && !allowRemoteReadOnly) {
    fail("remote or production-like targets require CERP_MIGRATION_READONLY_APPROVED=1 and remain read-only");
  }
  return url;
}

function fileSha256(filename) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filename));
  return hash.digest("hex");
}

function validateBackup(backupFile, expectedSha) {
  if (!backupFile) fail("a backup file is required (--backup or CERP_MIGRATION_BACKUP_FILE)");
  const resolved = path.resolve(backupFile);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0) fail("backup must be a non-empty regular file");
  if (!expectedSha || !/^[a-f0-9]{64}$/i.test(expectedSha)) fail("a 64-character backup SHA-256 is required");
  const actualSha = fileSha256(resolved);
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) fail("backup SHA-256 mismatch");
  const disk = fs.statfsSync(path.dirname(resolved));
  const freeBytes = disk.bavail * disk.bsize;
  if (freeBytes < stat.size * 2) fail("backup filesystem has less than twice the backup size available");
  return { file: resolved, bytes: stat.size, sha256: actualSha, free_bytes: freeBytes };
}

function supportSql(name) {
  return fs.readFileSync(`${SOL06_SUPPORT}.${name}.sql`, "utf8");
}

function patchSupportSql(filename, name) {
  const supportFile = path.join(SUPPORT_DIR, `${filename.slice(0, -4)}.${name}.sql`);
  return fs.existsSync(supportFile) ? fs.readFileSync(supportFile, "utf8") : null;
}

async function runSqlFile(client, sql) {
  const executable = sql.replace(/^\\set[^\n]*\n/gm, "");
  return client.query(executable);
}

async function patchLedger(client) {
  const appliedResult = await client.query(
    `SELECT filename,sha256,applied_at::text AS applied_at
     FROM public.cerp_schema_migrations ORDER BY filename`
  );
  const local = new Map(inventory().patches.map((patch) => [patch.filename, patch.sha256]));
  const applied = new Map(appliedResult.rows.map((row) => [row.filename, row]));
  const checksumMismatches = appliedResult.rows
    .filter((row) => local.has(row.filename) && local.get(row.filename) !== row.sha256)
    .map((row) => row.filename);
  const pending = [...local.keys()].filter((filename) => !applied.has(filename));
  const unknownApplied = appliedResult.rows.filter((row) => !local.has(row.filename)).map((row) => row.filename);
  return { applied: appliedResult.rows.length, pending, checksum_mismatches: checksumMismatches, unknown_applied: unknownApplied };
}

async function preflight(options = {}) {
  const rawUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  assertDatabaseTarget(rawUrl, process.env.CERP_MIGRATION_READONLY_APPROVED === "1");
  const backup = validateBackup(
    options.backup ?? process.env.CERP_MIGRATION_BACKUP_FILE,
    options.backupSha ?? process.env.CERP_MIGRATION_BACKUP_SHA256
  );
  const client = databaseClient({ connectionString: rawUrl });
  await client.connect();
  const started = Date.now();
  try {
    const identity = await client.query(
      `SELECT current_database() AS database,current_user AS database_user,
              current_setting('server_version') AS server_version,
              pg_database_size(current_database())::text AS database_bytes`
    );
    const ledger = await patchLedger(client);
    if (ledger.checksum_mismatches.length || ledger.unknown_applied.length) {
      fail(`migration ledger divergence: ${JSON.stringify(ledger)}`);
    }
    await runSqlFile(client, supportSql("preflight"));
    return {
      status: "passed",
      checked_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      identity: identity.rows[0],
      backup,
      ledger,
    };
  } finally {
    await client.end();
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function integrity(rawUrl) {
  assertDatabaseTarget(rawUrl, process.env.CERP_MIGRATION_READONLY_APPROVED === "1");
  const client = databaseClient({ connectionString: rawUrl });
  await client.connect();
  const started = Date.now();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const tableResult = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const tableCounts = {};
    for (const { tablename } of tableResult.rows) {
      const result = await client.query(`SELECT count(*)::text AS count FROM public.${quoteIdentifier(tablename)}`);
      tableCounts[tablename] = result.rows[0].count;
    }
    const invalidConstraints = await client.query(
      `SELECT conrelid::regclass::text AS table_name,conname,contype
       FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated
       ORDER BY conrelid::regclass::text,conname`
    );
    const duplicateChecks = await client.query(
      `SELECT 'units.code' AS key,count(*)::int AS groups FROM (SELECT lower(code) FROM public.units GROUP BY lower(code) HAVING count(*)>1) d
       UNION ALL SELECT 'warehouses.code',count(*)::int FROM (SELECT lower(code) FROM public.warehouses GROUP BY lower(code) HAVING count(*)>1) d
       UNION ALL SELECT 'magasins.code',count(*)::int FROM (SELECT lower(code) FROM public.magasins GROUP BY lower(code) HAVING count(*)>1) d
       UNION ALL SELECT 'app_roles.role_key',count(*)::int FROM (SELECT lower(role_key) FROM public.app_roles GROUP BY lower(role_key) HAVING count(*)>1) d`
    );
    const foreignKeys = await client.query(
      `SELECT c.conname,ns.nspname AS source_schema,src.relname AS source_table,
              nt.nspname AS target_schema,tgt.relname AS target_table,
              array_agg(sa.attname::text ORDER BY ord.n)::text[] AS source_columns,
              array_agg(ta.attname::text ORDER BY ord.n)::text[] AS target_columns
       FROM pg_constraint c
       JOIN pg_class src ON src.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=src.relnamespace
       JOIN pg_class tgt ON tgt.oid=c.confrelid JOIN pg_namespace nt ON nt.oid=tgt.relnamespace
       JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY ord(source_attnum,target_attnum,n) ON true
       JOIN pg_attribute sa ON sa.attrelid=src.oid AND sa.attnum=ord.source_attnum
       JOIN pg_attribute ta ON ta.attrelid=tgt.oid AND ta.attnum=ord.target_attnum
       WHERE c.contype='f' AND ns.nspname='public'
       GROUP BY c.conname,ns.nspname,src.relname,nt.nspname,tgt.relname
       ORDER BY src.relname,c.conname`
    );
    const orphans = [];
    for (const fk of foreignKeys.rows) {
      const source = `${quoteIdentifier(fk.source_schema)}.${quoteIdentifier(fk.source_table)}`;
      const target = `${quoteIdentifier(fk.target_schema)}.${quoteIdentifier(fk.target_table)}`;
      const join = fk.source_columns.map((column, index) => `s.${quoteIdentifier(column)} = t.${quoteIdentifier(fk.target_columns[index])}`).join(" AND ");
      const nonNull = fk.source_columns.map((column) => `s.${quoteIdentifier(column)} IS NOT NULL`).join(" AND ");
      const missing = `t.${quoteIdentifier(fk.target_columns[0])} IS NULL`;
      const result = await client.query(`SELECT count(*)::text AS count FROM ${source} s LEFT JOIN ${target} t ON ${join} WHERE ${nonNull} AND ${missing}`);
      if (result.rows[0].count !== "0") orphans.push({ constraint: fk.conname, table: fk.source_table, count: result.rows[0].count });
    }
    const readiness = (await client.query(
      `SELECT * FROM public.fn_business_prerequisite_status('STOCK')
       UNION ALL SELECT * FROM public.fn_business_prerequisite_status('PLANNING')
       UNION ALL SELECT * FROM public.fn_business_prerequisite_status('PRODUCTION')
       ORDER BY flow,prerequisite_code`
    )).rows;
    const ledger = await patchLedger(client);
    await client.query("COMMIT");
    const blockingInvalidConstraints = invalidConstraints.rows.filter((row) => row.contype === "f");
    const fingerprint = sha256(JSON.stringify({ tableCounts, ledger }));
    return {
      status: blockingInvalidConstraints.length === 0
        && duplicateChecks.rows.every((row) => row.groups === 0)
        && orphans.length === 0
        && readiness.every((row) => row.ready)
        ? "passed" : "failed",
      checked_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      table_counts: tableCounts,
      table_count: tableResult.rows.length,
      unvalidated_constraints: invalidConstraints.rows,
      invalid_foreign_keys: blockingInvalidConstraints,
      duplicate_checks: duplicateChecks.rows,
      foreign_key_count: foreignKeys.rows.length,
      orphans,
      readiness,
      ledger,
      fingerprint,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

function systemEnv(extra = {}) {
  const allowed = [
    "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES",
    "ProgramFiles", "ProgramFiles(x86)", "COMMONPROGRAMFILES", "PNPM_HOME", "COREPACK_HOME",
  ];
  const env = {};
  for (const key of allowed) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

function command(name, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(name, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? systemEnv(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    fail(`${name} ${args.join(" ")} failed (${result.status})${details ? `: ${details}` : ""}`);
  }
  return { duration_ms: Date.now() - started, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function waitForPostgres(container) {
  const deadline = Date.now() + 60_000;
  let consecutiveReady = 0;
  while (Date.now() < deadline) {
    const logs = spawnSync("docker", ["logs", container], {
      env: systemEnv(), encoding: "utf8", windowsHide: true,
    });
    const initializationComplete = /PostgreSQL init process complete; ready for start up/i.test(
      `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`
    );
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "cerp_e2e", "-d", "cerp_test"], {
      env: systemEnv(), stdio: "ignore", windowsHide: true,
    });
    consecutiveReady = initializationComplete && result.status === 0 ? consecutiveReady + 1 : 0;
    if (consecutiveReady >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("PostgreSQL final server did not become stably ready within 60 seconds");
}

function rehearsalMarkdown(report) {
  return `# Répétition de migration isolée — SOL-06

- Statut : **${report.status}**
- Exécutée : ${report.completed_at}
- PostgreSQL : ${report.postgres_image}
- Base source : ${report.source.identity.database}, ${report.source.identity.database_bytes} octets
- Sauvegarde : ${report.source.backup.bytes} octets, SHA-256 \`${report.source.backup.sha256}\`
- Patches avant/après : ${report.before.ledger.applied} / ${report.after.ledger.applied}
- Intégrité avant/après : ${report.before.status} / ${report.after.status}
- Rejeu du runner : ${report.replay.applied_zero ? "0 patch (conforme)" : "non conforme"}
- Refus métier négatif : SQLSTATE ${report.negative_gate.sqlstate}
- Rollback test-only : ${report.rollback.status}
- Restauration vers base neuve : ${report.restore.status}
- Empreinte source/restaurée : \`${report.before.fingerprint}\` / \`${report.restore.fingerprint}\`

## Durées réelles

| Étape | Durée (ms) |
|---|---:|
${Object.entries(report.durations).map(([step, duration]) => `| ${step} | ${duration} |`).join("\n")}

La pile PostgreSQL était liée à \`127.0.0.1\`, stockée en tmpfs et détruite en fin d'exécution. Aucune URL ni donnée de production n'a été utilisée.
`;
}

async function proveNegativeGate(databaseUrl) {
  const client = databaseClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE public.erp_settings SET reliability='ESTIMATED' WHERE key='stock.valuation_method'");
    try {
      await client.query(
        `INSERT INTO public.stock_movements (movement_no,movement_type,status,notes)
         VALUES ('SOL06-NEGATIVE-GATE','ADJUSTMENT','DRAFT','must be rolled back')`
      );
      fail("negative readiness gate unexpectedly allowed a stock movement");
    } catch (error) {
      if (error.code !== "P2606") throw error;
      await client.query("ROLLBACK");
      return { status: "passed", sqlstate: error.code, detail: JSON.parse(error.detail) };
    }
  } finally {
    await client.end();
  }
}

async function proveRollback(databaseUrl) {
  const client = databaseClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SET cerp.migration_rehearsal = 'on'");
    const planningExecutionRollback = patchSupportSql(PLANNING_EXECUTION_PATCH, "rollback");
    const planningExecutionObject = await client.query(
      "SELECT to_regclass('public.planning_user_preferences') IS NOT NULL AS present"
    );
    if (planningExecutionRollback && planningExecutionObject.rows[0].present) {
      await client.query("SET cerp.sol21_preferences_exported = 'yes'");
      await runSqlFile(client, planningExecutionRollback);
    }
    const toolingTechnicalGedRollback = patchSupportSql(TOOLING_TECHNICAL_GED_PATCH, "rollback");
    const toolingTechnicalGedObject = await client.query(
      "SELECT to_regclass('public.outillage_allocations') IS NOT NULL AS present"
    );
    if (toolingTechnicalGedRollback && toolingTechnicalGedObject.rows[0].present) {
      await runSqlFile(client, toolingTechnicalGedRollback);
    }
    const stockIntelligenceRollback = patchSupportSql(STOCK_INTELLIGENCE_PATCH, "rollback");
    const stockIntelligenceObject = await client.query(
      "SELECT to_regclass('public.stock_intelligence_policy_versions') IS NOT NULL AS present"
    );
    if (stockIntelligenceRollback && stockIntelligenceObject.rows[0].present) {
      await runSqlFile(client, stockIntelligenceRollback);
    }
    const procurementReliabilityRollback = patchSupportSql(PROCUREMENT_RELIABILITY_PATCH, "rollback");
    const procurementReliabilityObject = await client.query(
      "SELECT to_regclass('public.procurement_promised_date_events') IS NOT NULL AS present"
    );
    if (procurementReliabilityRollback && procurementReliabilityObject.rows[0].present) {
      await runSqlFile(client, procurementReliabilityRollback);
    }
    const commercialReliabilityRollback = patchSupportSql(COMMERCIAL_RELIABILITY_PATCH, "rollback");
    const commercialReliabilityObject = await client.query(
      "SELECT to_regclass('public.commercial_quote_events') IS NOT NULL AS present"
    );
    if (commercialReliabilityRollback && commercialReliabilityObject.rows[0].present) {
      await client.query("SET cerp.allow_sol17_rollback = 'SOL-17'");
      await runSqlFile(client, commercialReliabilityRollback);
    }
    const marginTraceabilityRollback = patchSupportSql(MARGIN_TRACEABILITY_PATCH, "rollback");
    const marginEvidenceColumn = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='margin_input_versions'
           AND column_name='evidence_contract_version'
       ) AS present`
    );
    if (marginTraceabilityRollback && marginEvidenceColumn.rows[0].present) {
      await runSqlFile(client, marginTraceabilityRollback);
    }
    const readinessRollback = patchSupportSql(PRODUCTION_READINESS_PATCH, "rollback");
    const readinessObject = await client.query(
      "SELECT to_regprocedure('public.fn_business_prerequisite_status_v2(text)') IS NOT NULL AS present"
    );
    if (readinessRollback && readinessObject.rows[0].present) {
      await runSqlFile(client, readinessRollback);
    }
    await runSqlFile(client, supportSql("rollback"));
    const objects = await client.query(
      `SELECT to_regprocedure('public.fn_business_prerequisite_status(text)') IS NULL AS function_removed,
              to_regprocedure('public.fn_business_prerequisite_status_v2(text)') IS NULL AS function_v2_removed,
              NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='margin_input_versions'
                  AND column_name='evidence_contract_version'
              ) AS margin_traceability_removed,
              to_regclass('public.commercial_quote_events') IS NULL
                AND to_regclass('public.commercial_order_cancellations') IS NULL
                AND to_regclass('public.commercial_command_receipts') IS NULL
                AND to_regprocedure('public.fn_commercial_evidence_append_only()') IS NULL
                AS commercial_reliability_removed,
              to_regclass('public.procurement_promised_date_events') IS NULL
                AND to_regclass('public.procurement_anomaly_actions') IS NULL
                AND to_regclass('public.procurement_policy_versions') IS NULL
                AND to_regclass('public.procurement_command_receipts') IS NULL
                AND to_regprocedure('public.fn_procurement_evidence_append_only()') IS NULL
                AS procurement_reliability_removed,
              to_regclass('public.stock_intelligence_policy_versions') IS NULL
                AND to_regclass('public.stock_intelligence_command_receipts') IS NULL
                AND to_regprocedure('public.fn_stock_intelligence_evidence_append_only()') IS NULL
                AS stock_intelligence_removed,
              to_regclass('public.outillage_tool_parameter_versions') IS NULL
                AND to_regclass('public.piece_version_tool_requirements') IS NULL
                AND to_regclass('public.outillage_allocations') IS NULL
                AND to_regclass('public.outillage_lifecycle_events') IS NULL
                AND to_regprocedure('public.fn_outillage_lifecycle_event_immutable_20()') IS NULL
                AND to_regprocedure('public.fn_outillage_parameter_period_no_overlap_20()') IS NULL
                AND to_regprocedure('public.fn_ged_validate_canonical_entity_link_20()') IS NULL
                AS tooling_technical_ged_removed,
              to_regclass('public.planning_user_preferences') IS NULL
                AND to_regprocedure('public.fn_planning_color_map_is_valid(jsonb)') IS NULL
                AS planning_execution_removed,
              NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_stock_reference_readiness_2606') AS trigger_removed`
    );
    if (!objects.rows[0].function_removed || !objects.rows[0].function_v2_removed
        || !objects.rows[0].margin_traceability_removed || !objects.rows[0].commercial_reliability_removed
        || !objects.rows[0].procurement_reliability_removed
        || !objects.rows[0].stock_intelligence_removed
        || !objects.rows[0].tooling_technical_ged_removed
        || !objects.rows[0].planning_execution_removed
        || !objects.rows[0].trigger_removed) {
      fail("rollback left SOL-06 objects behind");
    }
    return { status: "passed", ...objects.rows[0] };
  } finally {
    await client.end();
  }
}

async function rehearse(options = {}) {
  const port = Number(options.port ?? process.env.CERP_MIGRATION_DB_PORT ?? 55436);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) fail("invalid isolated PostgreSQL port");
  const container = `cerp-sol06-${process.pid}-${Date.now()}`;
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cerp-sol06-"));
  const backupFile = path.join(runRoot, "cerp-test-before-sol06.dump");
  const databaseUrl = `postgresql://cerp_e2e:cerp_sol06_only@127.0.0.1:${port}/cerp_test`;
  const baseEnv = systemEnv({
    DATABASE_URL: databaseUrl,
    CERP_E2E_ISOLATED: "1",
    CERP_E2E_QUIET: "1",
    CERP_MIGRATION_REHEARSAL: "1",
    CERP_E2E_STOP_BEFORE_PATCH: SOL06_PATCH,
  });
  const report = {
    status: "failed",
    started_at: new Date().toISOString(),
    postgres_image: POSTGRES_IMAGE,
    isolated_target: { host: "127.0.0.1", port, database: "cerp_test", storage: "tmpfs" },
    durations: {},
  };
  let containerStarted = false;
  try {
    command("docker", [
      "run", "--name", container, "--rm", "-d",
      "-e", "POSTGRES_USER=cerp_e2e",
      "-e", "POSTGRES_PASSWORD=cerp_sol06_only",
      "-e", "POSTGRES_DB=cerp_test",
      "-p", `127.0.0.1:${port}:5432`,
      "--tmpfs", "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g",
      POSTGRES_IMAGE,
    ]);
    containerStarted = true;
    await waitForPostgres(container);

    report.durations.source_migration = command(process.execPath, ["scripts/e2e/migrate-isolated.js"], { env: baseEnv }).duration_ms;
    report.durations.source_seed = command(process.execPath, ["scripts/e2e/seed-isolated.js"], { env: baseEnv }).duration_ms;

    report.durations.backup = command("docker", [
      "exec", container, "pg_dump", "-U", "cerp_e2e", "-d", "cerp_test", "-Fc", "-f", "/tmp/cerp-test-before-sol06.dump",
    ]).duration_ms;
    command("docker", ["cp", `${container}:/tmp/cerp-test-before-sol06.dump`, backupFile]);
    const backupSha = fileSha256(backupFile);

    const preflightStarted = Date.now();
    report.source = await preflight({ databaseUrl, backup: backupFile, backupSha });
    report.durations.preflight = Date.now() - preflightStarted;
    const expectedPending = expectedRehearsalPatches();
    if (JSON.stringify(report.source.ledger.pending) !== JSON.stringify(expectedPending)) {
      fail(`expected pending chain ${expectedPending.join(", ")}, found ${report.source.ledger.pending.join(", ")}`);
    }

    const beforeStarted = Date.now();
    const beforeClient = databaseClient({ connectionString: databaseUrl });
    await beforeClient.connect();
    try {
      const tables = await beforeClient.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
      const tableCounts = {};
      for (const { tablename } of tables.rows) {
        const count = await beforeClient.query(`SELECT count(*)::text AS count FROM public.${quoteIdentifier(tablename)}`);
        tableCounts[tablename] = count.rows[0].count;
      }
      const ledger = await patchLedger(beforeClient);
      report.before = {
        status: "passed",
        table_counts: tableCounts,
        ledger,
        fingerprint: sha256(JSON.stringify({ tableCounts, ledger })),
      };
    } finally {
      await beforeClient.end();
    }
    report.durations.integrity_before = Date.now() - beforeStarted;

    const migrationEnv = { ...baseEnv };
    delete migrationEnv.CERP_E2E_STOP_BEFORE_PATCH;
    report.durations.migration = command(process.execPath, ["scripts/db-patches.js", "up"], { env: migrationEnv }).duration_ms;

    const verifyClient = databaseClient({ connectionString: databaseUrl });
    await verifyClient.connect();
    const verifyStarted = Date.now();
    try {
      for (const patch of expectedPending) {
        const verifySql = patchSupportSql(patch, "verify");
        if (verifySql) await runSqlFile(verifyClient, verifySql);
      }
    } finally {
      await verifyClient.end();
    }
    report.durations.verify = Date.now() - verifyStarted;

    const replay = command(process.execPath, ["scripts/db-patches.js", "up"], { env: migrationEnv, capture: true });
    report.durations.replay = replay.duration_ms;
    report.replay = { applied_zero: /Applied 0 patch\(es\)\./.test(replay.stdout), output: replay.stdout.trim().split(/\r?\n/).slice(-1)[0] };
    if (!report.replay.applied_zero) fail("migration replay did not report zero applied patches");

    const afterStarted = Date.now();
    report.after = await integrity(databaseUrl);
    report.durations.integrity_after = Date.now() - afterStarted;
    if (report.after.status !== "passed") fail("post-migration integrity checks failed");

    const negativeStarted = Date.now();
    report.negative_gate = await proveNegativeGate(databaseUrl);
    report.durations.negative_gate = Date.now() - negativeStarted;

    const rollbackStarted = Date.now();
    report.rollback = await proveRollback(databaseUrl);
    report.durations.rollback = Date.now() - rollbackStarted;

    command("docker", ["exec", container, "createdb", "-U", "cerp_e2e", "cerp_restore"]);
    const restoreStarted = Date.now();
    command("docker", [
      "exec", container, "pg_restore", "-U", "cerp_e2e", "-d", "cerp_restore", "--exit-on-error", "/tmp/cerp-test-before-sol06.dump",
    ]);
    const restoreUrl = `postgresql://cerp_e2e:cerp_sol06_only@127.0.0.1:${port}/cerp_restore`;
    const restoreClient = databaseClient({ connectionString: restoreUrl });
    await restoreClient.connect();
    try {
      const tables = await restoreClient.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
      const tableCounts = {};
      for (const { tablename } of tables.rows) {
        const count = await restoreClient.query(`SELECT count(*)::text AS count FROM public.${quoteIdentifier(tablename)}`);
        tableCounts[tablename] = count.rows[0].count;
      }
      const ledger = await patchLedger(restoreClient);
      const fingerprint = sha256(JSON.stringify({ tableCounts, ledger }));
      report.restore = {
        status: fingerprint === report.before.fingerprint ? "passed" : "failed",
        fingerprint,
        table_counts_equal: JSON.stringify(tableCounts) === JSON.stringify(report.before.table_counts),
        ledger,
      };
      if (report.restore.status !== "passed") fail("restored database fingerprint differs from the source backup");
    } finally {
      await restoreClient.end();
    }
    report.durations.restore = Date.now() - restoreStarted;

    report.status = "passed";
    report.completed_at = new Date().toISOString();
    const reportDir = options["report-dir"] ? path.resolve(options["report-dir"]) : DEFAULT_REPORT_DIR;
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, "MIGRATION_REHEARSAL_SOL_06.json"), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(reportDir, "MIGRATION_REHEARSAL_SOL_06.md"), rehearsalMarkdown(report));
    return report;
  } finally {
    if (containerStarted) spawnSync("docker", ["rm", "-f", container], { env: systemEnv(), stdio: "ignore", windowsHide: true });
    const resolved = path.resolve(runRoot);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("cerp-sol06-")) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
}

async function main() {
  const commandName = process.argv[2] ?? "inventory";
  const options = parseArgs(process.argv.slice(3));
  if (commandName === "inventory") {
    const report = writeInventory(options["report-dir"] ? path.resolve(options["report-dir"]) : DEFAULT_REPORT_DIR);
    process.stdout.write(`SOL-06 inventory: patches=${report.patch_count}, recent_support_gaps=${report.recent_support_gaps.length}\n`);
    return;
  }
  if (commandName === "preflight") {
    const report = await preflight({
      backup: options.backup,
      backupSha: options["backup-sha"],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (commandName === "integrity") {
    const report = await integrity(process.env.DATABASE_URL);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== "passed") process.exitCode = 1;
    return;
  }
  if (commandName === "rehearse") {
    const report = await rehearse(options);
    process.stdout.write(`SOL-06 rehearsal ${report.status}; restore=${report.restore.status}; replay=${report.replay.applied_zero}\n`);
    return;
  }
  fail(`unknown command ${commandName}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SOL06_PATCH,
  MARGIN_TRACEABILITY_PATCH,
  COMMERCIAL_RELIABILITY_PATCH,
  PROCUREMENT_RELIABILITY_PATCH,
  STOCK_INTELLIGENCE_PATCH,
  PLANNING_EXECUTION_PATCH,
  expectedRehearsalPatches,
  inventory,
  inventoryMarkdown,
  validateBackup,
};
