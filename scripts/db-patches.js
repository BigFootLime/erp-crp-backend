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

dotenv.config({ path: path.join(ROOT_DIR, ".env") });

function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "status";
  const options = {
    command,
    dryRun: false,
    check: false,
    patchDir: DEFAULT_PATCH_DIR,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--patch-dir") {
      options.patchDir = path.resolve(args[++i]);
    } else if (arg.startsWith("--patch-dir=")) {
      options.patchDir = path.resolve(arg.slice("--patch-dir=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/db-patches.js status [--check] [--patch-dir DIR]
  node scripts/db-patches.js up [--dry-run] [--patch-dir DIR]
  node scripts/db-patches.js baseline [--dry-run] [--patch-dir DIR]

Commands:
  status    Show applied, pending, and checksum mismatch status.
  up        Apply pending SQL patches from db/patches in filename order.
  baseline  Record current patch files as already applied without executing SQL.

Notes:
  - Requires DATABASE_URL.
  - Stores patch metadata in ${MIGRATION_TABLE}.
  - Does not print connection strings or secrets.
`);
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
      const sha256 = crypto.createHash("sha256").update(sql).digest("hex");
      return { filename, fullPath, sql, sha256 };
    });
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

async function runStatus(client, patches, { check }) {
  const applied = await getApplied(client);
  const statuses = buildStatuses(patches, applied);
  printStatuses(statuses);

  const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
  const pending = statuses.filter((item) => item.status === "pending");
  if (mismatches.length > 0 || (check && pending.length > 0)) {
    process.exitCode = 1;
  }
}

async function runUp(client, patches, { dryRun }) {
  if (dryRun) {
    const applied = await getApplied(client);
    const statuses = buildStatuses(patches, applied);
    const pending = statuses.filter((item) => item.status === "pending");
    printStatuses(statuses);
    console.log("");
    console.log(`Dry-run: ${pending.length} patch(es) would be applied.`);
    return;
  }

  await withMigrationLock(client, async () => {
    await ensureMigrationTable(client);
    const applied = await getApplied(client);
    const statuses = buildStatuses(patches, applied);
    const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
    if (mismatches.length > 0) {
      printStatuses(statuses);
      throw new Error("Refusing to apply patches because one or more applied files changed checksum.");
    }

    const pending = statuses.filter((item) => item.status === "pending");
    for (const patch of pending) {
      console.log(`Applying ${patch.filename}`);
      try {
        await client.query(patch.sql);
        await client.query(`
          INSERT INTO ${MIGRATION_TABLE} (filename, sha256)
          VALUES ($1, $2)
        `, [patch.filename, patch.sha256]);
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {
          // Ignore rollback errors; the patch may not have opened a transaction.
        }
        throw error;
      }
    }
    console.log(`Applied ${pending.length} patch(es).`);
  });
}

async function runBaseline(client, patches, { dryRun }) {
  if (dryRun) {
    const applied = await getApplied(client);
    const statuses = buildStatuses(patches, applied);
    printStatuses(statuses);
    console.log("");
    console.log("Dry-run: patch metadata would be recorded without executing SQL.");
    return;
  }

  await withMigrationLock(client, async () => {
    await ensureMigrationTable(client);
    const applied = await getApplied(client);
    const statuses = buildStatuses(patches, applied);
    const mismatches = statuses.filter((item) => item.status === "checksum-mismatch");
    if (mismatches.length > 0) {
      printStatuses(statuses);
      throw new Error("Refusing to baseline because one or more applied files changed checksum.");
    }

    const pending = statuses.filter((item) => item.status === "pending");
    for (const patch of pending) {
      await client.query(`
        INSERT INTO ${MIGRATION_TABLE} (filename, sha256)
        VALUES ($1, $2)
      `, [patch.filename, patch.sha256]);
    }
    console.log(`Baselined ${pending.length} patch(es) without executing SQL.`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const patches = listPatches(options.patchDir);

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

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
