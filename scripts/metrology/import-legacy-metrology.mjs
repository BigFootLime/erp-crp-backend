#!/usr/bin/env node
// Privileged local operator command. No HTTP request can supply an import manifest.
import { readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { buildLegacyImportPlan } from "./legacy-import-plan.mjs";
import { prepareSourceVault, refuse, sha256, verifySourceFiles } from "./legacy-import-files.mjs";
import { assertImportDatabase, stageLegacyImport } from "./legacy-import-stage.mjs";

function options(args) {
  const flags = new Set(["--dry-run", "--stage", "--apply"]);
  const names = new Set(["--manifest", "--semantics", "--source-root", "--vault", "--actor-user-id",
    "--expected-database", "--batch-id", "--expected-source-set-sha256", "--receipt"]);
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key in result || (!flags.has(key) && !names.has(key))) refuse("unknown or repeated command option");
    if (flags.has(key)) result[key] = true;
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) refuse("missing command option value");
      result[key] = value;
    }
  }
  if (["--dry-run", "--stage", "--apply"].filter(key => result[key]).length !== 1) {
    refuse("choose exactly one of --dry-run, --stage or --apply");
  }
  return result;
}

async function output(result, filename) {
  const json = JSON.stringify({ ...result, recorded_at: new Date().toISOString() }, null, 2) + "\n";
  if (filename) await writeFile(filename, json, { flag: "wx", mode: 0o600 });
  process.stdout.write(json);
}

async function main() {
  const args = options(process.argv.slice(2));
  const actorUserId = Number(args["--actor-user-id"]);
  const actor = {
    user_id: actorUserId, role: "LOCAL_IMPORT", ip: null, user_agent: "metrology-import-cli",
    device_type: null, os: null, browser: null, path: "cli:metrology-import",
    page_key: null, client_session_id: null, request_id: null,
  };
  if (args["--apply"]) {
    if (!/^[a-f0-9-]{36}$/i.test(args["--batch-id"] ?? "") ||
        !/^[a-f0-9]{64}$/.test(args["--expected-source-set-sha256"] ?? "")) refuse("apply requires explicit batch identity and source digest");
    const repository = await import("../../dist/module/metrologie/repository/metrology-legacy-import.repository.js");
    const database = await import("../../dist/config/database.js");
    const pool = database.default.default ?? database.default;
    try {
      await assertImportDatabase(pool, args["--expected-database"], actorUserId);
      const batch = await pool.query("SELECT source_set_sha256 FROM public.metrologie_import_batches WHERE id=$1::uuid", [args["--batch-id"]]);
      if (batch.rows[0]?.source_set_sha256 !== args["--expected-source-set-sha256"]) refuse("staged batch digest differs from explicit target");
      await output(await repository.repoApplyStagedLegacyBatch({ batchId: args["--batch-id"], actor }), args["--receipt"]);
    } finally { await pool.end(); }
    return;
  }
  if (!args["--manifest"] || !args["--semantics"] || !args["--source-root"]) refuse("manifest, semantic sidecar and source root required");
  const manifestBytes = await readFile(args["--manifest"]);
  const semanticsBytes = await readFile(args["--semantics"]);
  const manifest = JSON.parse(manifestBytes);
  const semantics = JSON.parse(semanticsBytes);
  const sourceSetSha256 = sha256(Buffer.concat([manifestBytes, Buffer.from("\0"), semanticsBytes]));
  const plan = buildLegacyImportPlan(manifest, semantics);
  const progress = (phase) => (done, total) => {
    if (done % 100 === 0 || done === total) process.stderr.write(phase + ": " + done + "/" + total + "\n");
  };
  if (args["--dry-run"]) {
    await verifySourceFiles(args["--source-root"], plan.files, progress("verify"));
    await output({ dry_run: true, database_changed: false, antivirus_run: false,
      source_set_sha256: sourceSetSha256, manifest_sha256: sha256(manifestBytes), semantics_sha256: sha256(semanticsBytes), ...plan.summary }, args["--receipt"]);
    return;
  }
  if (!process.env.DATABASE_URL) refuse("database environment required for staging");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, statement_timeout: 30000, query_timeout: 35000 });
  await client.connect();
  try {
    await assertImportDatabase(client, args["--expected-database"], actorUserId);
    const storage = await import("../../dist/utils/cerpStorage.js");
    const scanner = await import("../../dist/shared/uploads/upload-scanner.js");
    const audit = await import("../../dist/module/metrologie/repository/metrology-shared.repository.js");
    const preparedFiles = await prepareSourceVault({
      sourceRoot: args["--source-root"], docsRoot: storage.ensureDocumentStoragePath("metrologie"),
      vaultRoot: args["--vault"], files: plan.files, sourceSetSha256,
      scan: scanner.scanUpload, progress: progress("copy-and-scan"),
    });
    await output(await stageLegacyImport({
      client, sourceSetSha256, manifest, semantics, plan, preparedFiles, actor, insertAudit: audit.insertAuditLog,
    }), args["--receipt"]);
  } finally { await client.end(); }
}

main().catch(error => {
  // Do not echo database URLs, raw records, driver error details or file contents.
  process.stderr.write(error.message?.startsWith("METROLOGY_IMPORT_REFUSED:") ? error.message + "\n" : "METROLOGY_IMPORT_FAILED\n");
  process.exitCode = 1;
});
