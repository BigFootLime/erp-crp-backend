#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const dotenv = require("dotenv");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_PATCH_DIR = path.join(ROOT_DIR, "db", "patches");
const MIGRATION_TABLE = "public.cerp_schema_migrations";
const LOCK_NAME = "cerp_schema_migrations";
const IMMUTABLE_ONLY_PATCHES = Object.freeze({
  "20260216_planning_visuals_programmation.sql":
    "e220d040caae9b18bb42d3c970104b2d2612bce53dac6b43c4aac60268491a1b",
  "20260804_auth_rate_limit_buckets.sql":
    "f61120b4068a36138b1d85c0269f764061a525aab6141f99df9c93ad6c5d27a2",
  "20260804_finance_settlement_state_469.sql":
    "55e8cb8304d71e790056111e6452b8825fc5349b88976bd0eea281359da543d5",
  "20260805_adv_reminders.sql":
    "df06021c03898c4e719634ab753c986122ad4645ffb7c146c6be0e4954c40616",
  "20260805_planning_convergence_governance.sql":
    "4ac0aa05dc489ae5f882491e7b41cc6e96ac3bcaabd554ecddfb82d6580734dc",
  "20260805_programmation_safe_reschedule_0004.sql":
    "341f7911a7bcb479fce6602d0567c51d47f083a08b37409e55d05cf3110f01b5",
  "20260805_quality_delivery_release_gate_0005.sql":
    "ceff91b88820e9943d199f71a73e32fd4f994d383f76aabb620ea648c9d1ae53",
  "20260805_station_offline_queue_0006.sql":
    "3e223c43698bdf3399ab2d37e6493d0d014952eb0fe877cdeb1c4b4f7f7db3da",
  "20260810_stock_old_new_navigation_446.sql":
    "4900f01411ab89349874fcd6d28993aa34a1ec560320d4d32b05489800bf3b9b",
  "20260803_admin_user_provisioning_boundary.sql":
    "c1b706a1d9ba046e63e7e0b05dfc132272bb27fccda7bd0efe8cf481ffbd5ca5",
  "20260804_article_unit_stock_contract.sql":
    "cd7b4bba961e2b9783cb3046e3f3dba794b8ce68c8252377f3ecbe105007d607",
  "20260809_account_invitation_activation.sql":
    "07fb4d08c4cd0bcf07abd1eb295a30db61b5d64f66d00406f4a24a4291fa4911",
  "20260810_stock_movement_event_correlation.sql":
    "736887f658a39504d7cd499cd6b630e05eba0e7fcaa8ecda9f3d92083a1278be",
  "20260810_system_reference_data_readiness.sql":
    "8a6bfa740ddc6e80f7b19ace948a92df379cc0df097879e9f5d125758a9f8eec",
  "20260811_account_provisioning_schema_repair.sql":
    "e4a994888e3ff0dc38923a128216647f76919d4001efc70e26219742befca116",
  "20260811_base_unit_drift_repair.sql":
    "53e6d11928dcd329b80fd493932aa29d2f0f65874b20a2cd1daa4e9a8847eb66",
  "20260811_ged_antivirus_quarantine.sql":
    "7e1e026c8a16be2609f072434d1930afbd248a543d96e3b013e89426fdaa1336",
  "20260811_production_readiness_center.sql":
    "2657f0f1eeca1a708a32ec41ae4c2a9eb2755df074d0a7984ccebcfce6b2dde5",
  "20260814_planning_execution_intelligence_0021.sql":
    "ca667814cae65e695ec45dccf407752432aa9e6f7e61b4d9a38ae6fcfd339107",
  "20260814_sol22_quality_intelligence.sql":
    "adf2b97867ef23f9c40ecd5df7c271cd40cc4d4d67c04cc60e7444f2cf367264",
  "20260814_adv_reliability_sol23.sql":
    "f14a8d356312133841168e681f4266142ff95f7e4a07dc6c2a18dd50b9a4f52e",
  "20260814_project_operations_sol24.sql":
    "e978abeb2b6758744d3824540b2552ef6b6ca90f0c634bc49dd7af403d4e8cd9",
  "20260814_admin_operations_sol25.sql":
    "741a16b710835f4bc05dcac52c7ba5ceb74504c962bfe4307805d2071142d3f3",
  "20260814_electronic_invoicing_sol26.sql":
    "03da2f92e7c99e1ffe437fb5443517585a9c20765322d85ab0cb83e378f7968e",
  "20260814_accounting_export_sol27.sql":
    "7daeedd829315f64e5bd5752a15047a45c80b0836093d135815305623b61e309",
  "20260814_api_contract_webhooks_sol28.sql":
    "42d9f33de100499836e7c1d58ef49e91daffa4af3861c59536bc2d0ab0f87f1f",
  "20260814_client_portal_sol29.sql":
    "d5c203c1c44f61b2b296d8fd08a5a35eb8b65060200119cbf7fe873f215d0f5c",
  "20260814_identification_labels_sol30.sql":
    "e9a2a116945105fbcce2a4ecc7246b3c9708a9d64920ed5f7a8ef94dc3740a7d",
});
const REALTIME_V1_FILENAME = "20260804_realtime_shared_control_plane.sql";
const REALTIME_V1_SHA256 = "a532c87aa9962b6171b65db421ee82069ed177bf6f5becb52295df4dacbc76f6";
const REALTIME_V2_FILENAME = "20260804_realtime_control_plane_v2.sql";

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "status";
  let patchDirWasSpecified = false;
  const options = {
    command,
    dryRun: false,
    check: false,
    patchDir: DEFAULT_PATCH_DIR,
    only: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--patch-dir") {
      patchDirWasSpecified = true;
      options.patchDir = path.resolve(args[++i]);
    } else if (arg.startsWith("--patch-dir=")) {
      patchDirWasSpecified = true;
      options.patchDir = path.resolve(arg.slice("--patch-dir=".length));
    } else if (arg === "--only") {
      if (options.only !== null) throw new Error("--only may be specified only once");
      options.only = args[++i];
    } else if (arg.startsWith("--only=")) {
      if (options.only !== null) throw new Error("--only may be specified only once");
      options.only = arg.slice("--only=".length);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.only !== null) {
    if (!options.only || options.only.includes("/") || options.only.includes("\\")) {
      throw new Error("--only requires one exact patch basename");
    }
    if (!Object.prototype.hasOwnProperty.call(IMMUTABLE_ONLY_PATCHES, options.only)) {
      throw new Error(`--only is not registered as an immutable patch selection: ${options.only}`);
    }
    if (command === "baseline") {
      throw new Error("--only is not supported for metadata-only baseline operations");
    }
    if (patchDirWasSpecified) {
      throw new Error(
        "--only always validates the canonical db/patches inventory and cannot be combined with --patch-dir"
      );
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/db-patches.js status [--check] [--only FILE] [--patch-dir DIR]
  node scripts/db-patches.js up [--dry-run] [--only FILE] [--patch-dir DIR]
  node scripts/db-patches.js baseline [--dry-run] [--patch-dir DIR]

Commands:
  status    Show applied, pending, and checksum mismatch status.
  up        Apply pending SQL patches from db/patches in filename order.
  baseline  Record current patch files as already applied without executing SQL.

Notes:
  - Requires DATABASE_URL.
  - Stores patch metadata in ${MIGRATION_TABLE}.
  - --only accepts a registered immutable basename and validates the complete inventory first.
  - Does not print connection strings or secrets.
`);
}

function canonicalizeSqlForHash(sql) {
  return sql.replace(/\r\n?/g, "\n");
}

function sha256Sql(sql) {
  return crypto
    .createHash("sha256")
    .update(canonicalizeSqlForHash(sql), "utf8")
    .digest("hex");
}

function sanitizeLeadingBom(sql) {
  let sanitized = sql;
  let previous;
  do {
    previous = sanitized;
    sanitized = sanitized.replace(/^([^\S\uFEFF]*)\uFEFF/, "$1 ");
  } while (sanitized !== previous);
  return sanitized;
}

function isIdentifierContinuation(char) {
  return Boolean(char) && (/[A-Za-z0-9_$]/.test(char) || char.codePointAt(0) >= 0x80);
}

function hasEscapeStringPrefix(sql, quoteIndex) {
  if (quoteIndex < 1 || !/[eE]/.test(sql[quoteIndex - 1])) return false;
  return quoteIndex === 1 || !isIdentifierContinuation(sql[quoteIndex - 2]);
}

function listPatches(patchDir) {
  if (!fs.existsSync(patchDir)) {
    throw new Error(`Patch directory not found: ${patchDir}`);
  }

  return fs.readdirSync(patchDir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((filename) => {
      const fullPath = path.join(patchDir, filename);
      const sql = fs.readFileSync(fullPath, "utf8");
      const sha256 = sha256Sql(sql);
      return { filename, fullPath, sql, sha256 };
    });
}

function canonicalPathKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function validateImmutableInventoryPath(patchDir, onlyFilename) {
  if (onlyFilename === null || onlyFilename === undefined) return;

  if (canonicalPathKey(patchDir) !== canonicalPathKey(DEFAULT_PATCH_DIR)) {
    throw new Error("Immutable --only requires the canonical db/patches inventory");
  }

  const directoryMetadata = fs.lstatSync(DEFAULT_PATCH_DIR);
  const realDirectory = fs.realpathSync.native(DEFAULT_PATCH_DIR);
  if (
    !directoryMetadata.isDirectory()
    || directoryMetadata.isSymbolicLink()
    || canonicalPathKey(realDirectory) !== canonicalPathKey(DEFAULT_PATCH_DIR)
  ) {
    throw new Error("Immutable --only refuses a substituted or symbolic-link patch directory");
  }

  for (const entry of fs.readdirSync(DEFAULT_PATCH_DIR, { withFileTypes: true })) {
    if (!entry.name.endsWith(".sql")) continue;
    const expectedPath = path.join(DEFAULT_PATCH_DIR, entry.name);
    const fileMetadata = fs.lstatSync(expectedPath);
    const realFile = fs.realpathSync.native(expectedPath);
    if (
      !entry.isFile()
      || entry.isSymbolicLink()
      || !fileMetadata.isFile()
      || fileMetadata.isSymbolicLink()
      || canonicalPathKey(realFile) !== canonicalPathKey(expectedPath)
    ) {
      throw new Error(`Immutable --only refuses a substituted or symbolic-link patch file: ${entry.name}`);
    }
  }
}

function immutableOnlyPatch(patches, onlyFilename) {
  if (onlyFilename === null || onlyFilename === undefined) return null;

  const matches = patches.filter((patch) => patch.filename === onlyFilename);
  if (matches.length !== 1) {
    throw new Error(
      `Immutable --only patch must exist exactly once in the global inventory: ${onlyFilename}`
    );
  }

  const patch = matches[0];
  const expectedSha256 = IMMUTABLE_ONLY_PATCHES[onlyFilename];
  if (patch.sha256 !== expectedSha256) {
    throw new Error(
      `Immutable --only checksum mismatch for ${onlyFilename}: expected canonical LF SHA-256 ${expectedSha256}, found ${patch.sha256}`
    );
  }
  return patch;
}

function topLevelSqlStatements(sql) {
  const statements = [];
  let statementStart = -1;
  let statementText = "";

  function appendPlaceholder(value) {
    if (statementStart === -1) {
      statementStart = value.start;
    }
    statementText += value.text;
  }

  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === "-" && next === "-") {
      if (statementStart !== -1) statementText += " ";
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      if (statementStart !== -1) statementText += " ";
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (char === "'" || char === '"') {
      const quote = char;
      const backslashEscapes = quote === "'" && hasEscapeStringPrefix(sql, index);
      appendPlaceholder({ start: index, text: quote === "'" ? " 'literal' " : ' "identifier" ' });
      index += 1;
      while (index < sql.length) {
        if (backslashEscapes && sql[index] === "\\") {
          index += Math.min(2, sql.length - index);
        } else if (sql[index] === quote && sql[index + 1] === quote) {
          index += 2;
        } else if (sql[index] === quote) {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      continue;
    }

    if (char === "$") {
      const tagMatch = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (tagMatch && !isIdentifierContinuation(sql[index - 1])) {
        const tag = tagMatch[0];
        appendPlaceholder({ start: index, text: " $quoted$ " });
        const closingIndex = sql.indexOf(tag, index + tag.length);
        index = closingIndex === -1 ? sql.length : closingIndex + tag.length;
        continue;
      }
    }

    if (char === ";") {
      if (statementStart !== -1 && statementText.trim() !== "") {
        statements.push({ start: statementStart, end: index + 1, text: statementText.trim() });
      }
      statementStart = -1;
      statementText = "";
      index += 1;
      continue;
    }

    if (statementStart === -1 && (/\s/.test(char) || char === "\uFEFF")) {
      index += 1;
      continue;
    }

    if (statementStart === -1) statementStart = index;
    statementText += char;
    index += 1;
  }

  if (statementStart !== -1 && statementText.trim() !== "") {
    statements.push({ start: statementStart, end: sql.length, text: statementText.trim() });
  }

  return statements;
}

function transactionControlKind(statementText) {
  const normalized = statementText.replace(/\s+/g, " ").trim().toUpperCase();
  if (/^(?:BEGIN(?: (?:WORK|TRANSACTION))?|START TRANSACTION)$/.test(normalized)) {
    return "begin";
  }
  if (/^COMMIT(?: (?:WORK|TRANSACTION))?$/.test(normalized)) {
    return "commit";
  }
  if (
    /^(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED|SET\s+(?:LOCAL\s+)?TRANSACTION|SET\s+SESSION\s+CHARACTERISTICS\s+AS\s+TRANSACTION)(?:\s|$)/.test(
      normalized
    )
  ) {
    return "unsupported";
  }
  return null;
}

function blankStatement(sql, statement) {
  return sql.slice(0, statement.start)
    + sql.slice(statement.start, statement.end).replace(/[^\r\n]/g, " ")
    + sql.slice(statement.end);
}

function sqlWithoutOuterTransaction(sql, filename = "SQL patch") {
  const statements = topLevelSqlStatements(sql);
  const controls = statements
    .map((statement) => ({ ...statement, kind: transactionControlKind(statement.text) }))
    .filter((statement) => statement.kind !== null);

  if (
    controls.length === 2
    && controls[0].kind === "begin"
    && controls[1].kind === "commit"
    && controls[0].start === statements[0]?.start
    && controls[1].start === statements[statements.length - 1]?.start
  ) {
    let executableSql = blankStatement(sql, controls[1]);
    executableSql = blankStatement(executableSql, controls[0]);
    return sanitizeLeadingBom(executableSql);
  }

  if (controls.length > 0) {
    throw new Error(
      `${filename} contains unsupported transaction control; use one outer BEGIN/COMMIT pair or none.`
    );
  }

  return sanitizeLeadingBom(sql);
}

async function tableExists(client) {
  const result = await client.query(`
    SELECT to_regclass($1) IS NOT NULL AS exists
  `, [MIGRATION_TABLE]);
  return result.rows[0]?.exists === true;
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      filename text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(client) {
  if (!(await tableExists(client))) {
    return new Map();
  }

  const result = await client.query(`
    SELECT filename, sha256, applied_at
    FROM ${MIGRATION_TABLE}
    ORDER BY filename
  `);

  return new Map(result.rows.map((row) => [row.filename, row]));
}

function buildStatuses(patches, applied) {
  return patches.map((patch) => {
    const row = applied.get(patch.filename);
    if (!row) {
      return { ...patch, status: "pending" };
    }
    if (row.sha256 !== patch.sha256) {
      return {
        ...patch,
        status: "checksum-mismatch",
        appliedAt: row.applied_at,
        appliedSha256: row.sha256,
      };
    }
    return { ...patch, status: "applied", appliedAt: row.applied_at };
  });
}

async function assertImmutableRealtimeV1Provenance(client, patches, applied) {
  if (!patches.some((patch) => patch.filename === REALTIME_V2_FILENAME)) return;
  const v1 = applied.get(REALTIME_V1_FILENAME);
  if (v1 && v1.sha256 !== REALTIME_V1_SHA256) {
    throw new Error(
      `Refusing ${REALTIME_V2_FILENAME}: ${REALTIME_V1_FILENAME} has unexpected ledger checksum ${v1.sha256}.`
    );
  }
  if (!applied.has(REALTIME_V2_FILENAME)) return;
  const relation = await client.query(
    "SELECT to_regclass('public.realtime_control_plane_v2_provenance') IS NOT NULL AS relation_exists"
  );
  if (relation.rows[0]?.relation_exists !== true) {
    throw new Error(`Refusing ${REALTIME_V2_FILENAME}: immutable v1 provenance relation is missing.`);
  }
  const result = await client.query(`
    SELECT inherited_v1, source_v1_sha256
    FROM public.realtime_control_plane_v2_provenance
    WHERE singleton
  `);
  const provenance = result.rows[0];
  const valid = provenance
    && (
      (provenance.inherited_v1 === true
        && provenance.source_v1_sha256 === REALTIME_V1_SHA256
        && v1?.sha256 === REALTIME_V1_SHA256)
      || (provenance.inherited_v1 === false
        && provenance.source_v1_sha256 === null
        && !v1)
    );
  if (!valid) {
    throw new Error(`Refusing ${REALTIME_V2_FILENAME}: immutable v1 provenance does not match the migration ledger.`);
  }
}

function printStatuses(statuses) {
  const counts = statuses.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  for (const item of statuses) {
    console.log(`${item.status.padEnd(18)} ${item.filename}`);
  }

  console.log("");
  console.log(`Summary: applied=${counts.applied || 0} pending=${counts.pending || 0} checksum-mismatch=${counts["checksum-mismatch"] || 0}`);
}

async function withClient(fn) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withMigrationLock(client, fn) {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_NAME]);
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
  }
}

async function runStatus(client, patches, { check, only }) {
  immutableOnlyPatch(patches, only);
  const applied = await getApplied(client);
  await assertImmutableRealtimeV1Provenance(client, patches, applied);
  const statuses = buildStatuses(patches, applied);
  printStatuses(statuses);

  const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
  const selected = only
    ? statuses.find((item) => item.filename === only)
    : null;
  const pending = selected
    ? (selected.status === "pending" ? [selected] : [])
    : statuses.filter((item) => item.status === "pending");
  if (selected) {
    console.log("");
    console.log(`Immutable selection: ${selected.filename} is ${selected.status}.`);
  }
  if (mismatches.length > 0 || (check && pending.length > 0)) {
    process.exitCode = 1;
  }
}

async function recordMigration(client, patch) {
  await client.query(`
    INSERT INTO ${MIGRATION_TABLE} (filename, sha256, applied_at)
    VALUES ($1, $2, statement_timestamp())
  `, [patch.filename, patch.sha256]);
}

async function applyPatch(client, patch) {
  const executableSql = sqlWithoutOuterTransaction(patch.sql, patch.filename);

  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK_NAME]);
    // Keep the server lexer aligned with sqlWithoutOuterTransaction even when
    // a database or role default was configured with the legacy `off` value.
    await client.query("SET LOCAL standard_conforming_strings = on");
    await client.query(executableSql);
    await recordMigration(client, patch);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // Preserve the original patch or registry error.
    }
    throw error;
  }
}

async function runUp(client, patches, { dryRun, only }) {
  immutableOnlyPatch(patches, only);
  if (dryRun) {
    const applied = await getApplied(client);
    await assertImmutableRealtimeV1Provenance(client, patches, applied);
    const statuses = buildStatuses(patches, applied);
    const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
    const selected = only ? statuses.find((item) => item.filename === only) : null;
    const pending = selected
      ? (selected.status === "pending" ? [selected] : [])
      : statuses.filter((item) => item.status === "pending");
    printStatuses(statuses);
    if (mismatches.length > 0) {
      throw new Error(
        "Refusing dry-run selection because one or more applied files changed checksum."
      );
    }
    console.log("");
    if (selected) console.log(`Immutable selection: ${selected.filename} is ${selected.status}.`);
    console.log(`Dry-run: ${pending.length} patch(es) would be applied.`);
    return;
  }

  await withMigrationLock(client, async () => {
    await ensureMigrationTable(client);
    const applied = await getApplied(client);
    await assertImmutableRealtimeV1Provenance(client, patches, applied);
    const statuses = buildStatuses(patches, applied);
    const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
    if (mismatches.length > 0) {
      printStatuses(statuses);
      throw new Error("Refusing to apply patches because one or more applied files changed checksum.");
    }

    const selected = only ? statuses.find((item) => item.filename === only) : null;
    const pending = selected
      ? (selected.status === "pending" ? [selected] : [])
      : statuses.filter((item) => item.status === "pending");
    if (selected) console.log(`Immutable selection: ${selected.filename} is ${selected.status}.`);
    for (const patch of pending) {
      console.log(`Applying ${patch.filename}`);
      await applyPatch(client, patch);
    }
    console.log(`Applied ${pending.length} patch(es).`);
  });
}

async function runBaseline(client, patches, { dryRun }) {
  if (dryRun) {
    const applied = await getApplied(client);
    await assertImmutableRealtimeV1Provenance(client, patches, applied);
    const statuses = buildStatuses(patches, applied);
    printStatuses(statuses);
    console.log("");
    console.log("Dry-run: patch metadata would be recorded without executing SQL.");
    return;
  }

  await withMigrationLock(client, async () => {
    await ensureMigrationTable(client);
    const applied = await getApplied(client);
    await assertImmutableRealtimeV1Provenance(client, patches, applied);
    const statuses = buildStatuses(patches, applied);
    const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
    if (mismatches.length > 0) {
      printStatuses(statuses);
      throw new Error("Refusing to baseline because one or more applied files changed checksum.");
    }

    const pending = statuses.filter((item) => item.status === "pending");
    for (const patch of pending) {
      await recordMigration(client, patch);
    }
    console.log(`Baselined ${pending.length} patch(es) without executing SQL.`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateImmutableInventoryPath(options.patchDir, options.only);
  const patches = listPatches(options.patchDir);
  immutableOnlyPatch(patches, options.only);

  await withClient(async (client) => {
    if (options.command === "status") {
      await runStatus(client, patches, options);
    } else if (options.command === "up") {
      await runUp(client, patches, options);
    } else if (options.command === "baseline") {
      await runBaseline(client, patches, options);
    } else {
      throw new Error(`Unknown command: ${options.command}`);
    }
  });
}

module.exports = {
  MIGRATION_TABLE,
  IMMUTABLE_ONLY_PATCHES,
  applyPatch,
  buildStatuses,
  canonicalizeSqlForHash,
  immutableOnlyPatch,
  listPatches,
  parseArgs,
  recordMigration,
  runUp,
  sha256Sql,
  sqlWithoutOuterTransaction,
  validateImmutableInventoryPath,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
