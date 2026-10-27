#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const PATCH_DIR = path.join(ROOT, 'db', 'patches');
const TEST_ONLY_PATCH_DIR = path.join(ROOT, 'db', 'test-only-patches');
const TEST_ONLY_OUTILLAGE_PATCHES = [
  '20261025_outillage_supplier_master_offers_test.sql',
  '20261025_outillage_indicative_catalogue_prices_test_only.sql',
];
const BOOTSTRAP = path.join(ROOT, 'db', 'e2e', 'legacy-bootstrap.sql');
const NORMALIZE = path.join(ROOT, 'db', 'e2e', 'normalize-empty-uuid-spine.sql');
const HISTORICAL_RUNTIME_CONTRACT = path.join(ROOT, 'db', 'e2e', 'historical-runtime-contract.sql');
const HISTORICAL_USER_AVATAR_PREREQUISITE = path.join(ROOT, 'db', 'e2e', 'historical-user-avatar-prerequisite.sql');
const DATA_ONLY_BASELINES = new Set(['20260727_repair_article_category_orphans_168.sql']);
const NORMALIZE_BEFORE = '20260219_commande_affaires_livraison_production.sql';
const REHEARSAL_STOP_PATCH = '20260810_system_reference_data_readiness.sql';
const USER_AVATARS_PATCH = '20261014_user_avatars_1563.sql';

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
  return require('../migrations/patch-dependencies').orderPatchDependencies(
    files.sort((left, right) => left.localeCompare(right))
  );
}

function runPatch(filename, command, patchDir = PATCH_DIR) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerp-sol05-patch-'));
  try {
    fs.copyFileSync(path.join(patchDir, filename), path.join(tempDir, filename));
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

async function assertTestOnlyOutillageSchema() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT coalesce(array_agg(required.name ORDER BY required.name)
        FILTER (WHERE to_regclass('public.' || required.name) IS NULL), '{}') AS missing
      FROM unnest(ARRAY[
        'outillage_fabricant_fournisseur_master',
        'outillage_tool_actual_purchase_prices',
        'outillage_tool_fournisseur_master',
        'outillage_tool_indicative_catalogue_price',
        'outillage_tool_receipt_idempotence',
        'outillage_tool_supplier_catalogue'
      ]) AS required(name)
    `);
    const missing = result.rows[0]?.missing ?? [];
    if (missing.length > 0) fail(`test-only outillage schema is incomplete: ${missing.join(', ')}`);
  } finally {
    await client.end();
  }
}

async function executeFile(client, filename) {
  const sql = fs.readFileSync(filename, 'utf8');
  await client.query(sql);
}

async function main() {
  assertIsolatedUrl(process.env.DATABASE_URL);
  const stopBefore = process.env.CERP_E2E_STOP_BEFORE_PATCH || null;
  if (stopBefore && (
    process.env.CERP_MIGRATION_REHEARSAL !== '1'
    || stopBefore !== REHEARSAL_STOP_PATCH
  )) {
    fail(`stop-before is reserved for the SOL-06 isolated rehearsal (${REHEARSAL_STOP_PATCH})`);
  }
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
  let stopBoundaryFound = false;
  let avatarPrerequisiteApplied = false;
  for (const filename of orderedPatches()) {
    if (filename === '20260903_customer_order_technical_maturation.sql') {
      // The September migration expects these historical columns. Its checksum
      // is already deployed: repair only this disposable bootstrap contract.
      const maturation = new Client({ connectionString: process.env.DATABASE_URL });
      await maturation.connect();
      try {
        await maturation.query('ALTER TABLE public.affaire ADD COLUMN IF NOT EXISTS devis_id bigint REFERENCES public.devis(id); ALTER TABLE public.commande_to_affaire ADD COLUMN IF NOT EXISTS role text');
      } finally { await maturation.end(); }
    }
    if (filename === stopBefore) {
      stopBoundaryFound = true;
      break;
    }
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
    if (filename === USER_AVATARS_PATCH) {
      const avatarPrerequisite = new Client({ connectionString: process.env.DATABASE_URL });
      await avatarPrerequisite.connect();
      try {
        await avatarPrerequisite.query("SET cerp.e2e_isolated = 'on'");
        await executeFile(avatarPrerequisite, HISTORICAL_USER_AVATAR_PREREQUISITE);
      } finally {
        await avatarPrerequisite.end();
      }
      avatarPrerequisiteApplied = true;
    }
    runPatch(filename, DATA_ONLY_BASELINES.has(filename) ? 'baseline' : 'up');
  }

  if (!normalized) fail(`normalization boundary ${NORMALIZE_BEFORE} was not found`);
  if (stopBefore && !stopBoundaryFound) fail(`rehearsal boundary ${stopBefore} was not found`);
  if (!stopBefore && !avatarPrerequisiteApplied) fail(`avatar prerequisite boundary ${USER_AVATARS_PATCH} was not found`);
  const contract = new Client({ connectionString: process.env.DATABASE_URL });
  await contract.connect();
  try {
    await contract.query("SET cerp.e2e_isolated = 'on'");
    await executeFile(contract, HISTORICAL_RUNTIME_CONTRACT);
    if (!stopBefore) {
      const avatarBindingTrigger = await contract.query(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgname = 'trg_operational_media_users_profile_picture'
            AND tgrelid = 'public.users'::regclass
            AND tgfoid = to_regprocedure('public.fn_operational_media_sync_binding()')
            AND tgenabled <> 'D'
            AND NOT tgisinternal
        ) AS attached
      `);
      if (!avatarBindingTrigger.rows[0]?.attached) fail('user avatar operational-media trigger is missing after isolated replay');
    }
  } finally {
    await contract.end();
  }
  if (!stopBefore) {
    for (const filename of TEST_ONLY_OUTILLAGE_PATCHES) runPatch(filename, 'up', TEST_ONLY_PATCH_DIR);
    await assertTestOnlyOutillageSchema();
  }
  const status = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'db-patches.js'), 'status', ...(stopBefore ? [] : ['--check'])],
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
  if (stopBefore) process.stdout.write(`SOL-06 rehearsal source stopped before ${stopBefore}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
