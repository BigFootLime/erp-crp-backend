/*
 * #1372 end-to-end account-request qualification.
 *
 * This file is intentionally standalone. It boots a disposable shared-directory
 * authority and a site literally named cerp_prod on the owned loopback fixture
 * cluster. It must never be pointed at a network database or a pre-existing
 * cerp_prod database.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
require('ts-node/register/transpile-only');

const { Client } = require('pg');
const request = require('supertest');
const { totpForStep } = require('../../src/module/auth/domain/mfa');
const { prepareOwnerBootstrap } = require('../../src/managed-tests/owner-bootstrap');
const { prepareTemplate, verifyTemplate } = require('../../src/managed-tests/template');
const { installEmptyDirectory } = require('../../src/shared-directory/install');
const { DirectoryClient } = require('../../src/shared-directory/client');

const backendRoot = path.resolve(__dirname, '../..');
const runtimeRoot = path.resolve(backendRoot, '../..', 'cerp-onboarding-1563-runtime');
const nonce = crypto.randomBytes(16).toString('hex');
const directoryId = crypto.randomUUID();
const authorityDb = `cerp_directory_${directoryId.replace(/-/g, '')}`;
const productionDb = 'cerp_prod';
const privateRuntimeRoot = process.env.CERP_ACCOUNT_REQUEST_RUNTIME_ROOT
  ?? (process.platform === 'win32'
    ? runtimeRoot
    : '/run/cerp-account-requests-fixtures');
const fixtureRoot = path.join(privateRuntimeRoot, `account-requests-${nonce}`);
const checks = [];
const serveMode = process.argv.includes('--serve');
const created = new Map();
let ownedTemplate;
let authorityChild;
let sourceClient;
let sitePool;
let diagnostics = '';

const fixtureConnection = new URL(process.env.CERP_ACCOUNT_REQUEST_FIXTURE_DATABASE_URL ?? 'postgresql://cerp_fixture@127.0.0.1:15463/cerp_test');
if (!['127.0.0.1', 'localhost', '::1'].includes(fixtureConnection.hostname) || fixtureConnection.pathname !== '/cerp_test' || Number(fixtureConnection.port || 5432) !== 15463) {
  throw new Error('FIXTURE_DATABASE_URL_INVALID');
}
const fixtureRole = decodeURIComponent(fixtureConnection.username);
const directoryRolePassword = crypto.randomBytes(32).toString('base64url');
const dbUrl = (database, role = fixtureRole) => {
  const url = new URL(fixtureConnection);
  url.pathname = `/${database}`;
  url.username = role;
  url.password = role === 'cerp_directory_app' ? directoryRolePassword : fixtureConnection.password;
  return url.toString();
};
const directoryFixtureUrl = () => {
  const url = new URL(dbUrl(authorityDb, 'cerp_directory_app'));
  url.password = '';
  return url.toString();
};
const sql = (...parts) => fs.readFile(path.join(backendRoot, ...parts), 'utf8');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, condition) => {
  if (!condition) throw new Error(`CHECK_FAILED:${name}`);
  checks.push(name);
};
const productionHeaders = { 'X-CERP-Database': productionDb };

// The public contract keeps the historical field names: `surname` is the
// applicant's given name and drives the immutable Directory username base.
function publicRequestBody(givenName, familyName, email) {
  return {
    name: familyName,
    surname: givenName,
    email,
    password: 'Fixture!AccountRequest1372',
    avatar_key: 'programmer',
  };
}

async function queryIdentity(client, expectedDb) {
  const row = (await client.query('SELECT current_database() AS db,current_user AS actor')).rows[0];
  // Docker exposes PostgreSQL's container address/5432 to the server itself;
  // the loopback-only 127.0.0.1:15463 guard is enforced on the client URL above.
  check(`owned fixture identity ${expectedDb}`, row.db === expectedDb && row.actor === fixtureRole);
}

async function prepareOwnedTemplate() {
  const template = `cerp_test_template_fixture_${nonce.slice(0, 10)}`;
  const sourceEnv = path.join(fixtureRoot, 'source.env');
  const templateRoot = path.join(fixtureRoot, 'template-control');
  const dataRoot = path.join(fixtureRoot, 'template-data');
  await fs.mkdir(templateRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(sourceEnv, `DATABASE_URL=${JSON.stringify(dbUrl('cerp_test'))}\n`, { mode: 0o600 });
  const config = {
    control_root: templateRoot,
    data_root: dataRoot,
    admin_database_url: dbUrl('postgres'),
    source_env: sourceEnv,
    template_database: template,
    template_version: `account-requests-${nonce.slice(0, 10)}`,
    api_release: backendRoot,
    app_user: 'fixture',
    app_group: 'fixture',
    minimum_free_memory_mb: 256,
    minimum_free_disk_mb: 512,
    pg_dump: process.env.CERP_ACCOUNT_REQUEST_PG_DUMP ?? (process.platform === 'win32' ? path.join(runtimeRoot, 'pgsql', 'bin', 'pg_dump.exe') : '/usr/bin/pg_dump'),
    pg_restore: process.env.CERP_ACCOUNT_REQUEST_PG_RESTORE ?? (process.platform === 'win32' ? path.join(runtimeRoot, 'pgsql', 'bin', 'pg_restore.exe') : '/usr/bin/pg_restore'),
    systemctl: 'fixture-adapter',
  };
  await prepareTemplate(config);
  await verifyTemplate(config);
  const admin = new Client({ connectionString: dbUrl('postgres') });
  await admin.connect();
  try {
    const oid = (await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1', [template])).rows[0]?.oid;
    if (!oid) throw new Error('FIXTURE_TEMPLATE_CREATE_FAILED');
    ownedTemplate = { database: template, version: config.template_version, oid };
  } finally { await admin.end(); }
  return template;
}

async function createOwnedDatabase(admin, database, template, deferMarker = false) {
  const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [database])).rowCount > 0;
  if (exists) throw new Error(`FIXTURE_DATABASE_ALREADY_EXISTS:${database}`);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE "${template}"`);
  const marker = crypto.randomUUID();
  const db = new Client({ connectionString: dbUrl(database) });
  await db.connect();
  try {
    await queryIdentity(db, database);
    const oid = (await db.query('SELECT oid::text FROM pg_database WHERE datname=current_database()')).rows[0].oid;
    created.set(database, { marker, oid, marked: false });
    if (!deferMarker) await markOwnedDatabase(database);
  } finally { await db.end(); }
}

async function markOwnedDatabase(database) {
  const record = created.get(database);
  if (!record || record.marked) return;
  const db = new Client({ connectionString: dbUrl(database) });
  await db.connect();
  try {
    await db.query('CREATE TABLE public.cerp_account_request_fixture_marker(nonce uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())');
    await db.query('INSERT INTO public.cerp_account_request_fixture_marker(nonce) VALUES($1::uuid)', [record.marker]);
    record.marked = true;
  } finally { await db.end(); }
}

async function applyMfaPatch(database) {
  const client = new Client({ connectionString: dbUrl(database) });
  await client.connect();
  try {
    await queryIdentity(client, database);
    await client.query(await sql('db', 'patches', 'support', '20261016_account_mfa_requirement_1372.preflight.sql'));
    await client.query(await sql('db', 'patches', '20261016_account_mfa_requirement_1372.sql'));
    await client.query(await sql('db', 'patches', 'support', '20261016_account_mfa_requirement_1372.verify.sql'));
  } finally { await client.end(); }
}

async function applySitePasswordAssurancePatch(database) {
  const client = new Client({ connectionString: dbUrl(database) });
  await client.connect();
  try {
    await queryIdentity(client, database);
    await client.query(await sql('db', 'patches', '20261016_directory_password_assurance_1372.sql'));
  } finally { await client.end(); }
}

async function waitForAuthority(client) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { await client.call('info', {}); return; } catch { await pause(250); }
  }
  throw new Error('DIRECTORY_FIXTURE_START_TIMEOUT');
}

async function loginWithMfa(app, username, password) {
  const login = await request(app).post('/api/v1/auth/login').set(productionHeaders).send({ username, password });
  check(`real password login ${username}`, login.status === 200 && !login.body.token && typeof login.body.challenge_token === 'string');
  const enrollmentSecret = login.body.totp?.secret;
  if (typeof enrollmentSecret !== 'string') throw new Error('FIXTURE_MFA_ENROLLMENT_SECRET_MISSING');
  const verify = await request(app).post('/api/v1/auth/mfa/verify').set(productionHeaders).send({
    challenge_token: login.body.challenge_token,
    code: totpForStep(enrollmentSecret, Math.floor(Date.now() / 30000)),
  });
  check(`real MFA session ${username}`, verify.status === 200 && typeof verify.body.token === 'string' && verify.body.token.length > 20);
  return { ...verify.body, enrollmentSecret };
}

async function serveBrowserFixture(app, owner, ownerPassword, moduleKey) {
  if (!serveMode) return;
  if (process.env.CERP_E2E_ISOLATED !== '1' || process.env.ACCOUNT_REQUEST_PRODUCTION_FIXTURE !== '1') {
    throw new Error('ACCOUNT_REQUEST_SERVE_OPT_IN_REQUIRED');
  }
  const corsOrigin = process.env.E2E_ACCOUNT_REQUEST_CORS_ORIGIN;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(corsOrigin || '')) {
    throw new Error('ACCOUNT_REQUEST_FIXTURE_CORS_ORIGIN_REQUIRED');
  }
  const outer = express();
  outer.disable('x-powered-by');
  outer.use((req, res, next) => {
    if (req.headers.origin === corsOrigin) {
      res.set('Access-Control-Allow-Origin', corsOrigin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,Idempotency-Key,X-CERP-Database,Account-Request-Receipt,X-Request-Id,X-Correlation-Id');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  });
  outer.get('/__e2e/account-request-fixture', (_req, res) => res.status(200).json({ nonce, fixture: 'account-request-prod' }));
  outer.use(app);
  const listener = await new Promise((resolve, reject) => {
    const server = outer.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('ACCOUNT_REQUEST_FIXTURE_LISTEN_FAILED');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const inputs = path.join(fixtureRoot, 'browser-inputs.env');
  const fixtureInputs = {
    E2E_ACCOUNT_REQUEST_API_URL: `${baseUrl}/api/v1`,
    E2E_ACCOUNT_REQUEST_SOCKET_URL: baseUrl,
    E2E_ACCOUNT_REQUEST_FIXTURE_MARKER_URL: `${baseUrl}/__e2e/account-request-fixture`,
    E2E_ACCOUNT_REQUEST_FIXTURE_NONCE: nonce,
    E2E_ACCOUNT_REQUEST_OWNER_USERNAME: owner.username,
    E2E_ACCOUNT_REQUEST_OWNER_PASSWORD: ownerPassword,
    E2E_ACCOUNT_REQUEST_OWNER_MFA_SECRET: owner.enrollmentSecret,
    E2E_ACCOUNT_REQUEST_STANDARD_ROLE: 'Employee',
    E2E_ACCOUNT_REQUEST_STANDARD_MODULE: moduleKey,
    E2E_ACCOUNT_REQUEST_BUSINESS_ROLE: 'Employee',
    E2E_ACCOUNT_REQUEST_BUSINESS_MODULE: moduleKey,
    E2E_ACCOUNT_REQUEST_CORS_ORIGIN: corsOrigin,
  };
  await fs.writeFile(inputs, `${Object.entries(fixtureInputs).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ result: 'FIXTURE_BROWSER_READY', fixture_only: true, private_inputs: inputs }));
  await new Promise((resolve) => {
    const stop = () => listener.close(() => resolve());
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

async function verifyEnrollment(app, challenge, label) {
  const enrollmentSecret = challenge.body.totp?.secret;
  if (typeof enrollmentSecret !== 'string') throw new Error('FIXTURE_MFA_ENROLLMENT_SECRET_MISSING');
  const verify = await request(app).post('/api/v1/auth/mfa/verify').set(productionHeaders).send({
    challenge_token: challenge.body.challenge_token,
    code: totpForStep(enrollmentSecret, Math.floor(Date.now() / 30000)),
  });
  check(`real MFA verifies ${label}`, verify.status === 200 && typeof verify.body.token === 'string' && verify.body.token.length > 20);
  return verify.body;
}

async function submitPublic(app, body) {
  return request(app).post('/api/v1/auth/account-requests').set(productionHeaders).send(body);
}

async function cleanup() {
  if (authorityChild && !authorityChild.killed) authorityChild.kill('SIGTERM');
  if (sitePool) await sitePool.end().catch(() => undefined);
  if (sourceClient) await sourceClient.end().catch(() => undefined);
  const admin = new Client({ connectionString: dbUrl('postgres') });
  await admin.connect().catch(() => undefined);
  try {
    for (const [database, marker] of [...created.entries()].reverse()) {
      const row = (await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1', [database])).rows[0];
      if (!row || row.oid !== marker.oid) continue;
      const client = new Client({ connectionString: dbUrl(database) });
      await client.connect();
      let owned = false;
      try {
        const markerTable = (await client.query("SELECT to_regclass('public.cerp_account_request_fixture_marker') AS relation")).rows[0]?.relation;
        owned = markerTable === 'cerp_account_request_fixture_marker'
          && (await client.query('SELECT nonce::text FROM public.cerp_account_request_fixture_marker WHERE nonce=$1::uuid', [marker.marker])).rowCount === 1;
      }
      finally { await client.end().catch(() => undefined); }
      if (owned) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    }
    if (ownedTemplate) {
      const row = (await admin.query('SELECT oid::text FROM pg_database WHERE datname=$1', [ownedTemplate.database])).rows[0];
      if (row?.oid === ownedTemplate.oid) {
        const template = new Client({ connectionString: dbUrl(ownedTemplate.database) });
        await template.connect();
        let exact = false;
        try {
          exact = (await template.query('SELECT version FROM public.cerp_test_template_meta WHERE singleton=true')).rows[0]?.version === ownedTemplate.version;
        } finally { await template.end().catch(() => undefined); }
        if (exact) await admin.query(`DROP DATABASE "${ownedTemplate.database}" WITH (FORCE)`);
      }
    }
  } finally { await admin.end().catch(() => undefined); }
}

async function main() {
  await fs.mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  const admin = new Client({ connectionString: dbUrl('postgres') });
  await admin.connect();
  let template;
  try {
    await queryIdentity(admin, 'postgres');
    await admin.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cerp_directory_app') THEN CREATE ROLE cerp_directory_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; ELSE ALTER ROLE cerp_directory_app LOGIN; END IF; END $$");
    // base64url output has no SQL metacharacters and is never emitted.
    await admin.query(`ALTER ROLE cerp_directory_app PASSWORD '${directoryRolePassword}'`);
  } finally { await admin.end(); }

  template = await prepareOwnedTemplate();
  const templateAdmin = new Client({ connectionString: dbUrl('postgres') });
  await templateAdmin.connect();
  try {
    await createOwnedDatabase(templateAdmin, productionDb, template);
    // installEmptyDirectory rejects non-template tables, so the ownership
    // marker for the authority is added only after that canonical install.
    await createOwnedDatabase(templateAdmin, authorityDb, template, true);
  } finally { await templateAdmin.end(); }
  await applyMfaPatch(productionDb);
  await applySitePasswordAssurancePatch(productionDb);
  // installEmptyDirectory creates the owner from this source schema.
  await applyMfaPatch(authorityDb);

  sourceClient = new Client({ connectionString: dbUrl(authorityDb) });
  await sourceClient.connect();
  await require('../managed-tests/directory-company-fixture.cjs').prepareCanonicalCompanyFixture(sourceClient);
  await require('../managed-tests/directory-owner-fixture.cjs').prepareDirectoryOwnerFixture(sourceClient);
  const ownerPassword = `FixtureA1+${crypto.randomBytes(20).toString('hex')}`;
  const seed = await prepareOwnerBootstrap({
    username: 'ACCOUNT_REQUEST_OWNER', name: 'FIXTURE', surname: 'OWNER',
    email: `owner.${nonce}@example.invalid`, password: ownerPassword,
    weekly_hours: 39, employment_type: 'CDI', job_title: 'Fixture owner',
  });
  await installEmptyDirectory(sourceClient, directoryId, seed);
  await markOwnedDatabase(authorityDb);
  await sourceClient.query(await sql('db', 'shared-directory', 'patches', '20261016_self_service_account_requests_1372.sql'));
  await sourceClient.query(await sql('db', 'shared-directory', 'patches', '20261016_directory_optional_mfa_1372.sql'));

  const callerKey = crypto.randomBytes(32).toString('hex');
  const callerFile = path.join(fixtureRoot, 'callers.json');
  const startupProbe = path.join(fixtureRoot, 'directory-startup-probe.cjs');
  await fs.writeFile(callerFile, JSON.stringify([{ site: productionDb, key: callerKey }]), { mode: 0o600 });
  await fs.writeFile(startupProbe, "const original=Promise.prototype.catch;Promise.prototype.catch=function(onRejected){return original.call(this,(error)=>{console.error(JSON.stringify({type:'directory_startup_probe',name:error?.name??null,message:error?.message??null,code:error?.code??null}));return onRejected(error);});};", { mode: 0o600 });
  for (const dir of ['data', 'data/tmp', 'data/images']) await fs.mkdir(path.join(fixtureRoot, dir), { recursive: true, mode: 0o700 });
  authorityChild = spawn(process.execPath, ['scripts/managed-tests/directory-fixture-service.cjs'], {
    cwd: backendRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test', DATABASE_URL: directoryFixtureUrl(), PGPASSWORD: directoryRolePassword,
      JWT_SECRET: crypto.randomBytes(48).toString('hex'), MFA_ROOT_KEY: crypto.randomBytes(32).toString('base64'),
      AUTH_RATE_LIMIT_HASH_KEY: crypto.randomBytes(48).toString('hex'), CERP_SHARED_DIRECTORY_ID: directoryId,
      CERP_DIRECTORY_CALLERS_FILE: callerFile, CERP_DIRECTORY_TEST_REGISTRATION_OPEN: 'true',
      CERP_STORAGE_ROOT: path.join(fixtureRoot, 'data'), CERP_TMP_ROOT: path.join(fixtureRoot, 'data', 'tmp'),
      CERP_IMAGES_ROOT: path.join(fixtureRoot, 'data', 'images'), CERP_DIRECTORY_FIXTURE_DIAGNOSTICS: 'true', NODE_OPTIONS: `--require ${startupProbe}`,
    }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  authorityChild.stderr.on('data', (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-12000); });
  const authority = new DirectoryClient('http://127.0.0.1:8085/internal/directory', productionDb, callerKey);
  await waitForAuthority(authority);
  check('shared Directory authority is reachable', true);

  process.env.DATABASE_URL = dbUrl(productionDb);
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.MFA_ROOT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.AUTH_RATE_LIMIT_HASH_KEY = crypto.randomBytes(48).toString('hex');
  process.env.CERP_SHARED_DIRECTORY_ENABLED = 'true';
  process.env.CERP_SHARED_DIRECTORY_SITE = productionDb;
  process.env.CERP_SHARED_DIRECTORY_ID = directoryId;
  process.env.CERP_DIRECTORY_SITE_CALL_KEY = callerKey;
  process.env.CERP_STORAGE_ROOT = path.join(fixtureRoot, 'site-data');
  process.env.CERP_TMP_ROOT = path.join(fixtureRoot, 'site-data', 'tmp');
  process.env.CERP_IMAGES_ROOT = path.join(fixtureRoot, 'site-data', 'images');
  for (const dir of [process.env.CERP_STORAGE_ROOT, process.env.CERP_TMP_ROOT, process.env.CERP_IMAGES_ROOT]) await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  sitePool = require('../../src/config/database').default;
  const runtime = require('../../src/shared-directory/site-runtime');
  await runtime.initializeSharedDirectorySite(sitePool, process.env);
  const app = require('../../src/config/app').default;
  check('site initializes shared Directory without fallback', true);

  const anonymousRegister = await request(app).post('/api/v1/auth/register').set(productionHeaders).send({});
  check('legacy public register cannot create an anonymous account', anonymousRegister.status === 401 && !anonymousRegister.body.token);

  const publicBody = publicRequestBody('ALIX', 'DUPONT', `alix.${nonce}@example.invalid`);
  const invalid = await submitPublic(app, { ...publicBody, role: 'Administrateur Systeme et Reseau', username: 'ROOT', mfa_required: false, database: 'cerp_test' });
  check('public request rejects role, username, MFA and database escalation fields', invalid.status === 400);
  const submitted = await submitPublic(app, publicBody);
  check('public request is accepted without identity session', submitted.status === 202 && submitted.body.status === 'PENDING' && typeof submitted.body.request_id === 'string' && typeof submitted.body.receipt === 'string' && !submitted.body.token && !submitted.body.username);
  const receipt = submitted.body.receipt;
  const stored = await sourceClient.query('SELECT receipt_hash,password_hash,status FROM public.cerp_directory_account_requests WHERE id=$1::uuid', [submitted.body.request_id]);
  check('authority stores only a receipt hash and password hash', stored.rows.length === 1 && stored.rows[0].receipt_hash !== receipt && /^[a-f0-9]{64}$/.test(stored.rows[0].receipt_hash));
  const noReceipt = await request(app).get('/api/v1/auth/account-requests/status').set(productionHeaders);
  const wrongReceipt = await request(app).get('/api/v1/auth/account-requests/status').set(productionHeaders).set('Authorization', 'Account-Request-Receipt invalid');
  const unknownReceipt = await request(app).get('/api/v1/auth/account-requests/status').set(productionHeaders).set('Authorization', `Account-Request-Receipt ${crypto.randomBytes(32).toString('base64url')}`);
  check('status rejects missing or malformed receipts', noReceipt.status === 400 && wrongReceipt.status === 400);
  const unknownReceiptReturnsGenericNotFound = unknownReceipt.status === 404;
  const pending = await request(app).get('/api/v1/auth/account-requests/status').set(productionHeaders).set('Authorization', `Account-Request-Receipt ${receipt}`);
  check('pending status contains no identity or session', pending.status === 200 && pending.body.status === 'PENDING' && !pending.body.username && !pending.body.token && !pending.body.email);
  const beforeApproval = await request(app).post('/api/v1/auth/login').set(productionHeaders).send({ username: 'ALIX', password: publicBody.password });
  const pendingRequestLoginRejected = beforeApproval.status === 401 && !beforeApproval.body.token;

  const owner = await loginWithMfa(app, seed.profile.username, ownerPassword);
  const ownerAuth = { ...productionHeaders, Authorization: `Bearer ${owner.token}` };
  const ownerClaims = jwt.verify(owner.token, process.env.JWT_SECRET);
  const ownerDirectorySession = typeof ownerClaims.directory_session === 'string' ? ownerClaims.directory_session : null;
  check('owner MFA session contains a verified Directory session for signed authority operations', typeof ownerDirectorySession === 'string' && /^dir_[a-f0-9]{64}$/.test(ownerDirectorySession));
  const authenticatedRegister = await request(app).post('/api/v1/auth/register').set(ownerAuth).send({});
  check('legacy register route is absent after authentication', authenticatedRegister.status === 404);
  const module = (await sitePool.query("SELECT module_key FROM public.app_modules WHERE is_active AND NOT is_protected ORDER BY module_key LIMIT 1")).rows[0]?.module_key;
  if (typeof module !== 'string') throw new Error('FIXTURE_SELECTABLE_MODULE_MISSING');
  await serveBrowserFixture(app, { ...owner, username: seed.profile.username }, ownerPassword, module);
  const list = await request(app).get('/api/v1/admin/account-requests?status=PENDING&limit=10').set(ownerAuth);
  check('recent-MFA SuperAdmin can list pending requests', list.status === 200 && Array.isArray(list.body.requests) && list.body.requests.some((row) => row.id === submitted.body.request_id));
  const approval = { expected_version: 0, primary_role: 'Employee', roles: ['Employee'], administrative_kind: 'STANDARD', module_keys: [module], link_historical_user_id: null };
  const historicalLink = await request(app).post(`/api/v1/admin/account-requests/${submitted.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', crypto.randomUUID()).send({ ...approval, link_historical_user_id: 1 });
  check('approval refuses implicit historical-user reconciliation', historicalLink.status === 422);
  const approvalKey = crypto.randomUUID();
  const approved = await request(app).post(`/api/v1/admin/account-requests/${submitted.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', approvalKey).send(approval);
  check('approval prepares the canonical profile, closes unselected modules, then activates the site projection', approved.status === 201 && approved.body.status === 'APPROVED' && approved.body.username === 'ALIX');
  const approvalReplay = await request(app).post(`/api/v1/admin/account-requests/${submitted.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', approvalKey).send(approval);
  check('approval is idempotent', approvalReplay.status === 201 && approvalReplay.body.request_id === approved.body.request_id);
  const identity = await sitePool.query('SELECT id,status,is_superadmin,directory_profile_id FROM public.users WHERE directory_username=$1', [approved.body.username]);
  const initiallySelectedModule = identity.rows[0] && (await sitePool.query('SELECT access FROM public.app_module_user_access WHERE user_id=$1 AND module_key=$2', [identity.rows[0].id, module])).rows[0]?.access;
  const membership = identity.rows[0] && await sourceClient.query('SELECT status FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid', [identity.rows[0].directory_profile_id]);
  check('approval activates the canonical membership and applies its explicit local module selection', identity.rows.length === 1 && identity.rows[0].status === 'Inactive' && identity.rows[0].is_superadmin === false && identity.rows[0].directory_profile_id && initiallySelectedModule === 'GRANTED' && membership?.rows.length === 1 && membership.rows[0].status === 'Active');
  const statusApproved = await request(app).get('/api/v1/auth/account-requests/status').set(productionHeaders).set('Authorization', `Account-Request-Receipt ${receipt}`);
  check('approved status reveals only the allocated username', statusApproved.status === 200 && statusApproved.body.status === 'APPROVED' && statusApproved.body.username === 'ALIX' && !statusApproved.body.email);

  const userLogin = await request(app).post('/api/v1/auth/login').set(productionHeaders).send({ username: approved.body.username, password: publicBody.password });
  check('approved standard account receives a real password session when not enrolled in MFA', userLogin.status === 200 && typeof userLogin.body.token === 'string' && !userLogin.body.challenge_token);
  const standardSession = userLogin.body;
  const standardMe = await request(app).get('/api/v1/auth/me').set(productionHeaders).set('Authorization', `Bearer ${standardSession.token}`);
  check('approved standard account receives a real site session without inherited MFA bypass state', standardMe.status === 200 && standardMe.body.user?.username === approved.body.username);
  const activatedIdentity = await sitePool.query('SELECT status FROM public.users WHERE directory_profile_id=$1::uuid', [identity.rows[0].directory_profile_id]);
  check('first real standard login reconciles the active canonical membership into the local projection', activatedIdentity.rows.length === 1 && activatedIdentity.rows[0].status === 'Active');
  const standardAudit = await request(app).get('/api/v1/audit-logs').set(productionHeaders).set('Authorization', `Bearer ${standardSession.token}`);
  const ownerAudit = await request(app).get('/api/v1/audit-logs').set(ownerAuth);
  check('standard account cannot read global audit logs while the owner remains authorized', standardAudit.status === 403 && ownerAudit.status === 200);
  await sitePool.query("UPDATE public.app_module_user_access SET access='DENIED' WHERE user_id=$1 AND module_key=$2", [identity.rows[0].id, module]);
  const staleApprovalReplay = await request(app).post(`/api/v1/admin/account-requests/${submitted.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', approvalKey).send(approval);
  const revokedModule = (await sitePool.query('SELECT access FROM public.app_module_user_access WHERE user_id=$1 AND module_key=$2', [identity.rows[0].id, module])).rows[0]?.access;
  check('approved replay cannot restore a subsequently revoked module access', staleApprovalReplay.status === 201 && revokedModule === 'DENIED');

  const resumeBody = publicRequestBody('REPRISE', 'PROJECTION', `resume.${nonce}@example.invalid`);
  const resumeSubmit = await submitPublic(app, resumeBody);
  const preparedApproval = { ...approval, expected_version: 0 };
  const prepared = await authority.call('account-request-approve', {
    directory_session: ownerDirectorySession,
    input: { id: resumeSubmit.body.request_id, key: crypto.randomUUID(), approval: preparedApproval },
  });
  check('signed Directory approval can stop after canonical preparation without a local projection', prepared.status === 'PROJECTION_PENDING' && typeof prepared.profile_id === 'string' && prepared.version === 1);
  const preparedLogin = await request(app).post('/api/v1/auth/login').set(productionHeaders).send({ username: prepared.username, password: resumeBody.password });
  check('prepared account cannot log in before the site projection is activated', preparedLogin.status === 401 && !preparedLogin.body.token);
  const resumable = await request(app).get('/api/v1/admin/account-requests?status=PROJECTION_PENDING&limit=10').set(ownerAuth);
  const preparedRow = resumable.body.requests?.find((row) => row.id === resumeSubmit.body.request_id);
  check('administrator reload exposes saved projection choices for the prepared request', resumable.status === 200 && preparedRow?.version === prepared.version && preparedRow?.primary_role === approval.primary_role && JSON.stringify(preparedRow?.roles) === JSON.stringify(approval.roles) && preparedRow?.administrative_kind === approval.administrative_kind && JSON.stringify(preparedRow?.module_keys) === JSON.stringify(approval.module_keys));
  const resumed = await request(app).post(`/api/v1/admin/account-requests/${resumeSubmit.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', crypto.randomUUID()).send({ ...preparedApproval, expected_version: prepared.version });
  check('HTTP approval resumes the prepared decision and activates it without changing its saved choices', resumed.status === 201 && resumed.body.status === 'APPROVED' && resumed.body.username === prepared.username);
  const resumedLogin = await request(app).post('/api/v1/auth/login').set(productionHeaders).send({ username: resumed.body.username, password: resumeBody.password });
  check('resumed approval permits a real standard password session', resumedLogin.status === 200 && typeof resumedLogin.body.token === 'string' && !resumedLogin.body.challenge_token);

  const businessBody = publicRequestBody('NORA', 'BUSINESS', `business.${nonce}@example.invalid`);
  const businessSubmit = await submitPublic(app, businessBody);
  const businessApproval = { ...approval, administrative_kind: 'BUSINESS_ADMIN' };
  const businessApproved = await request(app).post(`/api/v1/admin/account-requests/${businessSubmit.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', crypto.randomUUID()).send(businessApproval);
  check('business administrator approval creates an active Directory profile', businessApproved.status === 201 && businessApproved.body.status === 'APPROVED');
  const businessLogin = await request(app).post('/api/v1/auth/login').set(productionHeaders).send({ username: businessApproved.body.username, password: businessBody.password });
  check('business administrator must enroll MFA before obtaining a session', businessLogin.status === 200 && businessLogin.body.status === 'mfa_enrollment_required' && !businessLogin.body.token);
  const businessSession = await verifyEnrollment(app, businessLogin, 'business administrator');
  const businessMe = await request(app).get('/api/v1/auth/me').set(productionHeaders).set('Authorization', `Bearer ${businessSession.token}`);
  check('business administrator receives a site session only after real MFA enrollment', businessMe.status === 200 && businessMe.body.user?.username === businessApproved.body.username);

  const collisionBody = publicRequestBody('ALIX', 'MARTIN', `collision.${nonce}@example.invalid`);
  const collisionSubmit = await submitPublic(app, collisionBody);
  const collisionApproved = await request(app).post(`/api/v1/admin/account-requests/${collisionSubmit.body.request_id}/approve`).set(ownerAuth).set('Idempotency-Key', crypto.randomUUID()).send(approval);
  check('same given name allocates immutable numeric username suffix', collisionApproved.status === 201 && collisionApproved.body.username === 'ALIX2');

  const rejectedBody = publicRequestBody('JULES', 'REJECT', `reject.${nonce}@example.invalid`);
  const rejectedSubmit = await submitPublic(app, rejectedBody);
  const rejectKey = crypto.randomUUID();
  const rejected = await request(app).post(`/api/v1/admin/account-requests/${rejectedSubmit.body.request_id}/reject`).set(ownerAuth).set('Idempotency-Key', rejectKey).send({ expected_version: 0, reason: 'Fixture refusal' });
  check('reject is a terminal explicit decision', rejected.status === 200 && rejected.body.status === 'REJECTED');
  const deleted = await request(app).delete(`/api/v1/admin/account-requests/${rejectedSubmit.body.request_id}`).set(ownerAuth).set('Idempotency-Key', crypto.randomUUID()).send({ expected_version: 1 });
  check('only terminal request can be redacted', deleted.status === 204);
  const rejectedList = await request(app).get('/api/v1/admin/account-requests?status=REJECTED&limit=10').set(ownerAuth);
  check('redacted rejected request no longer appears in the administrator list', rejectedList.status === 200 && !rejectedList.body.requests.some((row) => row.id === rejectedSubmit.body.request_id));

  check('approved account remains a non-superadmin Directory projection', identity.rows.length === 1 && activatedIdentity.rows[0]?.status === 'Active' && identity.rows[0].is_superadmin === false && identity.rows[0].directory_profile_id);
  check('pending request cannot log in or create a session', pendingRequestLoginRejected);
  check('status hides an unknown opaque receipt with generic not-found', unknownReceiptReturnsGenericNotFound);
  return { result: 'PASS', checks: checks.length };
}

main().then((report) => {
  console.log(JSON.stringify({ result: report.result, checks: report.checks, fixture_only: true, live_production_changed: false, live_test_changed: false }));
}).catch(async (error) => {
  const safeError = JSON.stringify({ code: error?.code, message: error?.message, detail: error?.detail, where: error?.where });
  await fs.writeFile(path.join(fixtureRoot, 'diagnostic.log'), `${diagnostics}\n${safeError}\n`, { mode: 0o600 }).catch(() => undefined);
  const message = typeof error?.message === 'string' ? error.message : '';
  const failure = message.startsWith('CHECK_FAILED:') || /^FIXTURE_[A-Z_]+(?::[a-z0-9_]+)?$/i.test(message)
    ? message
    : error.code ?? error.name;
  console.error(JSON.stringify({ result: 'FAIL', checks: checks.length, failed_check: failure, diagnostic_file: path.join(fixtureRoot, 'diagnostic.log') }));
  process.exitCode = 1;
}).finally(cleanup);
