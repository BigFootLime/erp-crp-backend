#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const require = createRequire(import.meta.url);
const pgModule = process.env.CERP_BACKUP_PG_MODULE
  ? require(path.resolve(process.env.CERP_BACKUP_PG_MODULE))
  : require("pg");
const { Client } = pgModule;
const CRITICAL_TABLES = [
  "users",
  "articles",
  "stock_movements",
  "ordres_fabrication",
  "ged_blobs",
  "ged_documents",
  "project_tasks",
  "factures",
];
const STORAGE_COLUMNS = ["storage_key", "storage_path", "document_path", "file_path"];
const SIZE_COLUMNS = ["size_bytes", "file_size_bytes", "file_size"];

function fail(message) {
  throw new Error(`[SOL-10 recovery set] ${message}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) fail(`unexpected argument ${value}`);
    const [key, inline] = value.slice(2).split("=", 2);
    options[key] = inline ?? rest[++index];
  }
  return { command, options };
}

function required(value, label) {
  if (!value || !String(value).trim()) fail(`${label} is required`);
  return String(value).trim();
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(filename);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.tmp.${process.pid}`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temporary, filename);
}

function postgresEnvironment(rawUrl) {
  const url = new URL(rawUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) fail("DATABASE_URL must use PostgreSQL");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) fail("DATABASE_URL must name a database");
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
  };
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  delete env.DATABASE_URL;
  return { env, database, hostname: url.hostname };
}

async function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${binary} failed with ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function existingPublicTables(client) {
  const result = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema='public' AND table_type='BASE TABLE'
      ORDER BY table_name`
  );
  return result.rows.map((row) => row.table_name);
}

async function criticalCounts(client, tables) {
  const counts = {};
  for (const table of CRITICAL_TABLES.filter((name) => tables.includes(name))) {
    const result = await client.query(`SELECT count(*)::text AS count FROM public.${quoteIdentifier(table)}`);
    counts[table] = result.rows[0].count;
  }
  return counts;
}

async function migrationDigest(client, tables) {
  if (!tables.includes("cerp_schema_migrations")) return { count: 0, sha256: sha256Buffer(Buffer.from("")) };
  const result = await client.query(
    `SELECT filename,sha256 FROM public.cerp_schema_migrations ORDER BY filename`
  );
  const canonical = result.rows.map((row) => `${row.filename}|${row.sha256}`).join("\n");
  return { count: result.rows.length, sha256: sha256Buffer(Buffer.from(canonical)) };
}

async function readinessSummary(client) {
  const exists = await client.query(
    `SELECT to_regprocedure('public.fn_business_prerequisite_status(text)') IS NOT NULL AS present`
  );
  if (!exists.rows[0].present) return { available: false, blocking: null, scopes: [] };
  const scopes = [];
  for (const scope of ["STOCK", "PLANNING", "PRODUCTION"]) {
    const result = await client.query(
      `SELECT count(*) FILTER (WHERE NOT ready)::int AS blocking,
              count(*)::int AS checks
         FROM public.fn_business_prerequisite_status($1)`,
      [scope]
    );
    scopes.push({ scope, checks: result.rows[0].checks, blocking: result.rows[0].blocking });
  }
  return { available: true, blocking: scopes.reduce((sum, item) => sum + item.blocking, 0), scopes };
}

async function documentReferenceMetadata(client) {
  const result = await client.query(
    `SELECT c.table_name,c.column_name,
            EXISTS (
              SELECT 1 FROM information_schema.columns s
               WHERE s.table_schema='public' AND s.table_name=c.table_name AND s.column_name='sha256'
            ) AS has_sha256,
            (
              SELECT s.column_name FROM information_schema.columns s
               WHERE s.table_schema='public' AND s.table_name=c.table_name
                 AND s.column_name = ANY($2::text[])
               ORDER BY array_position($2::text[],s.column_name) LIMIT 1
            ) AS size_column,
            COALESCE((
              SELECT array_agg(a.attname ORDER BY k.ordinality)
                FROM pg_index i
                JOIN pg_class t ON t.oid=i.indrelid
                JOIN pg_namespace n ON n.oid=t.relnamespace
                JOIN unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) ON true
                JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
               WHERE n.nspname='public' AND t.relname=c.table_name AND i.indisprimary
            ),ARRAY[]::text[]) AS primary_key
       FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.column_name = ANY($1::text[])
      ORDER BY c.table_name,c.column_name`,
    [STORAGE_COLUMNS, SIZE_COLUMNS]
  );
  return result.rows;
}

function rowReferenceExpression(primaryKey) {
  if (!Array.isArray(primaryKey) || primaryKey.length === 0) return "md5(t.ctid::text)";
  const pairs = primaryKey.flatMap((column) => [`'${column.replaceAll("'", "''")}'`, `t.${quoteIdentifier(column)}::text`]);
  return `jsonb_build_object(${pairs.join(",")})::text`;
}

async function documentReferences(client) {
  const metadata = await documentReferenceMetadata(client);
  const references = [];
  for (const entry of metadata) {
    const table = quoteIdentifier(entry.table_name);
    const storage = quoteIdentifier(entry.column_name);
    const sha = entry.has_sha256 ? "lower(t.sha256::text)" : "NULL::text";
    const size = entry.size_column ? `t.${quoteIdentifier(entry.size_column)}::bigint` : "NULL::bigint";
    const rows = await client.query(
      `SELECT $1::text AS source_table,$2::text AS storage_column,
              ${rowReferenceExpression(entry.primary_key)} AS row_ref,
              t.${storage}::text AS storage_path,${sha} AS expected_sha256,${size} AS expected_size_bytes
         FROM public.${table} t
        WHERE t.${storage} IS NOT NULL AND btrim(t.${storage}::text) <> ''`,
      [entry.table_name, entry.column_name]
    );
    references.push(...rows.rows);
  }
  references.sort((left, right) =>
    `${left.source_table}|${left.storage_column}|${left.row_ref}`.localeCompare(
      `${right.source_table}|${right.storage_column}|${right.row_ref}`
    )
  );
  return references;
}

async function exportRecoverySet(options) {
  const output = path.resolve(required(options.output, "--output"));
  const databaseUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
  await fsp.mkdir(output, { recursive: true, mode: 0o700 });
  if ((await fsp.readdir(output)).length !== 0) fail("export output directory must be empty");

  const startedAt = new Date().toISOString();
  const dumpTemporary = path.join(output, "cerp.dump.tmp");
  const dumpFile = path.join(output, "cerp.dump");
  const catalogFile = path.join(output, "cerp.dump.catalog");
  const referencesFile = path.join(output, "document-references.jsonl");
  const pgDump = process.env.CERP_PG_DUMP_BIN || "pg_dump";
  const pgRestore = process.env.CERP_PG_RESTORE_BIN || "pg_restore";
  const connection = postgresEnvironment(databaseUrl);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const identityResult = await client.query(
      `SELECT pg_export_snapshot() AS snapshot_id,clock_timestamp()::text AS snapshot_at,
              pg_current_wal_lsn()::text AS wal_lsn,current_database() AS database,
              current_user AS database_user,current_setting('server_version') AS server_version,
              pg_database_size(current_database())::text AS database_bytes`
    );
    const identity = identityResult.rows[0];
    const tables = await existingPublicTables(client);
    const [references, counts, migrations, readiness, invalidFks] = await Promise.all([
      documentReferences(client),
      criticalCounts(client, tables),
      migrationDigest(client, tables),
      readinessSummary(client),
      client.query(
        `SELECT count(*)::int AS count FROM pg_constraint
          WHERE connamespace='public'::regnamespace AND contype='f' AND NOT convalidated`
      ),
    ]);

    await run(pgDump, [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      `--snapshot=${identity.snapshot_id}`,
      `--file=${dumpTemporary}`,
    ], { env: connection.env });
    await fsp.rename(dumpTemporary, dumpFile);
    const catalog = await run(pgRestore, ["--list", dumpFile], { env: connection.env });
    await fsp.writeFile(catalogFile, catalog.stdout, { mode: 0o600 });
    await fsp.writeFile(
      referencesFile,
      references.map((reference) => JSON.stringify(reference)).join("\n") + (references.length ? "\n" : ""),
      { mode: 0o600 }
    );
    await client.query("COMMIT");

    const dumpStat = await fsp.stat(dumpFile);
    if (dumpStat.size === 0) fail("pg_dump produced an empty archive");
    const metadata = {
      schema_version: 1,
      created_at: new Date().toISOString(),
      export_started_at: startedAt,
      snapshot_at: identity.snapshot_at,
      wal_lsn: identity.wal_lsn,
      database: identity.database,
      database_user: identity.database_user,
      server_version: identity.server_version,
      database_bytes: identity.database_bytes,
      public_table_count: tables.length,
      critical_table_counts: counts,
      migration_ledger: migrations,
      invalid_public_foreign_keys: invalidFks.rows[0].count,
      business_prerequisites: readiness,
      document_reference_count: references.length,
      dump: { file: "cerp.dump", bytes: dumpStat.size, sha256: await sha256File(dumpFile) },
      catalog: { file: "cerp.dump.catalog", sha256: await sha256File(catalogFile) },
      document_references: { file: "document-references.jsonl", sha256: await sha256File(referencesFile) },
    };
    await atomicJson(path.join(output, "database-metadata.json"), metadata);
    process.stdout.write(`${JSON.stringify({ status: "passed", command: "export", ...metadata })}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await fsp.rm(dumpTemporary, { force: true });
    throw error;
  } finally {
    await client.end();
  }
}

function normalizePosix(value) {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function safeRelative(candidate, root) {
  const normalizedCandidate = normalizePosix(candidate);
  const normalizedRoot = normalizePosix(root);
  if (normalizedCandidate === normalizedRoot) return "";
  if (!normalizedCandidate.startsWith(`${normalizedRoot}/`)) return null;
  const relative = normalizedCandidate.slice(normalizedRoot.length + 1);
  if (!relative || relative.split("/").some((part) => part === "..")) return null;
  return relative;
}

function referenceFingerprint(reference) {
  return sha256Buffer(Buffer.from(`${reference.source_table}|${reference.storage_column}|${reference.row_ref}`)).slice(0, 16);
}

function resolveSnapshotPath(reference, sourceMap, recoveryRoot) {
  const roots = sourceMap.roots ?? [];
  const candidates = [];
  const value = normalizePosix(reference.storage_path);
  if (reference.storage_column === "storage_key" || reference.source_table === "ged_blobs") {
    for (const root of roots.filter((item) => item.kind === "ged")) {
      candidates.push(path.join(recoveryRoot, root.snapshot, value));
    }
  }
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    for (const root of roots) {
      for (const alias of [root.source, ...(root.aliases ?? [])]) {
        const relative = safeRelative(value, alias);
        if (relative !== null) candidates.push(path.join(recoveryRoot, root.snapshot, ...relative.split("/")));
      }
    }
  } else {
    for (const root of roots) candidates.push(path.join(recoveryRoot, root.snapshot, ...value.split("/")));
  }
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))].filter((candidate) => {
    const relative = path.relative(path.resolve(recoveryRoot), candidate);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

async function readJsonLines(filename) {
  const content = await fsp.readFile(filename, "utf8");
  return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function verifyFiles(options) {
  const recoveryRoot = path.resolve(required(options.root, "--root"));
  const referencesFile = path.resolve(required(options.references, "--references"));
  const sourceMapFile = path.resolve(required(options["source-map"], "--source-map"));
  const output = path.resolve(required(options.output, "--output"));
  const references = await readJsonLines(referencesFile);
  const sourceMap = JSON.parse(await fsp.readFile(sourceMapFile, "utf8"));
  const failures = [];
  let verified = 0;
  let hashVerified = 0;
  let sizeVerified = 0;

  for (const reference of references) {
    const fingerprint = referenceFingerprint(reference);
    const candidates = resolveSnapshotPath(reference, sourceMap, recoveryRoot);
    let matched = null;
    for (const candidate of candidates) {
      try {
        if ((await fsp.stat(candidate)).isFile()) { matched = candidate; break; }
      } catch { /* candidate does not exist */ }
    }
    if (!matched) {
      failures.push({ reference: fingerprint, reason: candidates.length ? "missing" : "unresolved" });
      continue;
    }
    const stat = await fsp.stat(matched);
    if (reference.expected_size_bytes !== null && String(stat.size) !== String(reference.expected_size_bytes)) {
      failures.push({ reference: fingerprint, reason: "size_mismatch" });
      continue;
    }
    if (reference.expected_size_bytes !== null) sizeVerified += 1;
    if (reference.expected_sha256 && /^[a-f0-9]{64}$/i.test(reference.expected_sha256)) {
      if ((await sha256File(matched)) !== reference.expected_sha256.toLowerCase()) {
        failures.push({ reference: fingerprint, reason: "sha256_mismatch" });
        continue;
      }
      hashVerified += 1;
    }
    verified += 1;
  }

  const report = {
    schema_version: 1,
    verified_at: new Date().toISOString(),
    source: "database snapshot document references checked against staged recovery files",
    reliability: failures.length === 0 ? "VERIFIED" : "FAILED",
    reference_count: references.length,
    verified_count: verified,
    hash_verified_count: hashVerified,
    size_verified_count: sizeVerified,
    failure_count: failures.length,
    failures: failures.slice(0, 100),
  };
  await atomicJson(output, report);
  if (failures.length) fail(`${failures.length} document references are not restorable`);
  process.stdout.write(`${JSON.stringify({ status: "passed", command: "verify-files", ...report })}\n`);
}

function assertRestoreTarget(rawUrl) {
  if (process.env.CERP_RESTORE_APPROVED !== "1") fail("CERP_RESTORE_APPROVED=1 is required");
  const target = postgresEnvironment(rawUrl);
  if (/(^|[_-])(prod|production)([_-]|$)/i.test(target.database)) fail("restore into a production-like database is forbidden");
  if (!/(restore|recovery|cerp_test)/i.test(target.database)) fail("restore database name must contain restore, recovery or cerp_test");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(target.hostname);
  if (!loopback && process.env.CERP_RESTORE_ISOLATED !== "1") fail("remote restore requires CERP_RESTORE_ISOLATED=1");
  return target;
}

async function verifyRestoredDatabase(client, metadata) {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    const tables = await existingPublicTables(client);
    const counts = await criticalCounts(client, tables);
    const migrations = await migrationDigest(client, tables);
    const readiness = await readinessSummary(client);
    const invalidFks = await client.query(
      `SELECT count(*)::int AS count FROM pg_constraint
        WHERE connamespace='public'::regnamespace AND contype='f' AND NOT convalidated`
    );
    const failures = [];
    if (tables.length !== metadata.public_table_count) failures.push("public_table_count");
    if (migrations.count !== metadata.migration_ledger.count || migrations.sha256 !== metadata.migration_ledger.sha256) {
      failures.push("migration_ledger");
    }
    if (invalidFks.rows[0].count !== metadata.invalid_public_foreign_keys) failures.push("foreign_key_validation");
    for (const [table, expected] of Object.entries(metadata.critical_table_counts ?? {})) {
      if (counts[table] !== expected) failures.push(`row_count:${table}`);
    }
    if (metadata.business_prerequisites?.available && readiness.blocking !== metadata.business_prerequisites.blocking) {
      failures.push("business_prerequisites");
    }
    return { tables: tables.length, critical_table_counts: counts, migrations, readiness, invalid_public_foreign_keys: invalidFks.rows[0].count, failures };
  } finally {
    await client.query("COMMIT");
  }
}

async function restoreDatabase(options) {
  const dump = path.resolve(required(options.dump, "--dump"));
  const metadataFile = path.resolve(required(options.metadata, "--metadata"));
  const reportFile = path.resolve(required(options.report, "--report"));
  const rawUrl = required(process.env.DATABASE_URL, "DATABASE_URL");
  const target = assertRestoreTarget(rawUrl);
  const metadata = JSON.parse(await fsp.readFile(metadataFile, "utf8"));
  if ((await sha256File(dump)) !== metadata.dump.sha256) fail("database dump SHA-256 mismatch");
  const client = new Client({ connectionString: rawUrl });
  await client.connect();
  let clientClosed = false;
  const started = Date.now();
  try {
    const present = await client.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog','information_schema')`
    );
    if (present.rows[0].count !== 0) fail("restore target database must be empty");
    await client.end();
    clientClosed = true;
    await run(process.env.CERP_PG_RESTORE_BIN || "pg_restore", [
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
      `--dbname=${target.database}`,
      dump,
    ], { env: target.env });
    const verifyClient = new Client({ connectionString: rawUrl });
    await verifyClient.connect();
    try {
      const integrity = await verifyRestoredDatabase(verifyClient, metadata);
      const report = {
        schema_version: 1,
        restored_at: new Date().toISOString(),
        duration_seconds: (Date.now() - started) / 1000,
        target_database: target.database,
        source_snapshot_at: metadata.snapshot_at,
        integrity,
        reliability: integrity.failures.length === 0 ? "VERIFIED" : "FAILED",
      };
      await atomicJson(reportFile, report);
      if (integrity.failures.length) fail(`restored database integrity failed: ${integrity.failures.join(", ")}`);
      process.stdout.write(`${JSON.stringify({ status: "passed", command: "restore-database", ...report })}\n`);
    } finally {
      await verifyClient.end();
    }
  } finally {
    if (!clientClosed) await client.end().catch(() => undefined);
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "export") return exportRecoverySet(options);
  if (command === "verify-files") return verifyFiles(options);
  if (command === "restore-database") return restoreDatabase(options);
  fail("command must be export, verify-files or restore-database");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
