#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const PATCH_DIR = path.join(ROOT, 'db', 'patches');
const BOOTSTRAP = path.join(ROOT, 'db', 'e2e', 'legacy-bootstrap.sql');
const NORMALIZE = path.join(ROOT, 'db', 'e2e', 'normalize-empty-uuid-spine.sql');
const HISTORICAL_RUNTIME_CONTRACT = path.join(ROOT, 'db', 'e2e', 'historical-runtime-contract.sql');
const DATA_ONLY_BASELINES = new Set(['20260727_repair_article_category_orphans_168.sql']);
const NORMALIZE_BEFORE = '20260219_commande_affaires_livraison_production.sql';

function fail(message) {
  throw new Error(`[SOL-05 migration] ${message}`);
}

function assertIsolatedUrl(raw) {
  if (process.env.CERP_E2E_ISOLATED !== '1') fail('CERP_E2E_ISOLATED=1 is required');
  if (!raw) fail('DATABASE_URL is required');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    fail(`database host must be loopback, received ${url.hostname}`);
  }
  if (url.pathname !== '/cerp_test') fail(`database name must be cerp_test, received ${url.pathname}`);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') fail('PostgreSQL URL required');
}

function orderedPatches() {
  const files = fs.readdirSync(PATCH_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name);
  return files.sort((left, right) => {
    const a = left.slice(0, -4);
    const b = right.slice(0, -4);
    if (b.startsWith(`${a}_`)) return -1;
    if (a.startsWith(`${b}_`)) return 1;
    return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  });
}

function runPatch(filename, command) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerp-sol05-patch-'));
  try {
    fs.copyFileSync(path.join(PATCH_DIR, filename), path.join(tempDir, filename));
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'db-patches.js'), command, '--patch-dir', tempDir],
      { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    if (result.status !== 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      fail(`${command} failed for ${filename}`);
    }
    if (process.env.CERP_E2E_QUIET !== '1' && result.stdout) process.stdout.write(result.stdout);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function executeFile(client, filename) {
  const sql = fs.readFileSync(filename, 'utf8');
  await client.query(sql);
}

async function main() {
  assertIsolatedUrl(process.env.DATABASE_URL);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET cerp.e2e_isolated = 'on'");
    const identity = await client.query('SELECT current_database() AS database, inet_server_addr()::text AS host');
    if (identity.rows[0]?.database !== 'cerp_test') fail('connected database identity changed unexpectedly');
    await executeFile(client, BOOTSTRAP);
  } finally {
    await client.end();
  }

  let normalized = false;
  for (const filename of orderedPatches()) {
    if (!normalized && filename === NORMALIZE_BEFORE) {
      const normalizer = new Client({ connectionString: process.env.DATABASE_URL });
      await normalizer.connect();
      try {
        await normalizer.query("SET cerp.e2e_isolated = 'on'");
        await executeFile(normalizer, NORMALIZE);
      } finally {
        await normalizer.end();
      }
      normalized = true;
    }
    runPatch(filename, DATA_ONLY_BASELINES.has(filename) ? 'baseline' : 'up');
  }

  if (!normalized) fail(`normalization boundary ${NORMALIZE_BEFORE} was not found`);
  const contract = new Client({ connectionString: process.env.DATABASE_URL });
  await contract.connect();
  try {
    await contract.query("SET cerp.e2e_isolated = 'on'");
    await executeFile(contract, HISTORICAL_RUNTIME_CONTRACT);
  } finally {
    await contract.end();
  }
  const status = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'db-patches.js'), 'status', '--check'],
    { cwd: ROOT, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  if (status.stdout) {
    if (process.env.CERP_E2E_QUIET === '1') {
      const summary = status.stdout.split(/\r?\n/).find((line) => line.startsWith('Summary:'));
      if (summary) process.stdout.write(`${summary}\n`);
    } else {
      process.stdout.write(status.stdout);
    }
  }
  if (status.status !== 0) {
    if (status.stderr) process.stderr.write(status.stderr);
    fail('final patch inventory check failed');
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
