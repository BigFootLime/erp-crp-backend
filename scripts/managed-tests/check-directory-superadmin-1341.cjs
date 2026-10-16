// Disposable PostgreSQL qualification for Production superAdmin mutations.
// It rejects every non-loopback, non-fixture connection before creating a DB.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Client, Pool } = require('pg');

const port = 58932;
const fixtureUser = 'cerp_audit_fixture';
const appUser = 'cerp_audit_app';
const fixtureHost = process.env.CERP_AUDIT_FIXTURE_HOST ?? '127.0.0.1';
const nonce = crypto.randomBytes(16).toString('hex');
const database = `cerp_audit_admin_${nonce}`;
const databasePort = Number.parseInt(process.env.CERP_AUDIT_FIXTURE_DATABASE_PORT ?? String(port), 10);
const adminUrl = `postgresql://${fixtureUser}@${fixtureHost}:${databasePort}/postgres`;
const appUrl = `postgresql://${appUser}@${fixtureHost}:${databasePort}/${database}`;
const evidencePath = process.env.CERP_AUDIT_EVIDENCE_PATH
  ?? path.join(__dirname, '../../../private-directory-superadmin-1341.json');
let pool;
let fixtureAdmin;

function check(name, condition) {
  if (!condition) throw new Error(`CHECK_FAILED:${name}`);
  checks.push(name);
}
const checks = [];

function assertFixtureUrl(raw) {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'postgresql:' || parsed.hostname !== fixtureHost || parsed.port !== String(databasePort)
    || parsed.username !== appUser || parsed.pathname !== `/${database}` || parsed.password) {
    throw new Error('OWNED_DIRECTORY_FIXTURE_REQUIRED');
  }
}

function actor(profileId, userId, factorId, membershipVersion = 1, factorVersion = 1) {
  return {
    profile_id: profileId, source_user_id: userId, database: 'cerp_prod',
    username: 'FIXTURE', name: 'FIXTURE', surname: 'OWNER', email: 'fixture@example.invalid',
    avatar_key: null, avatar_asset_id: null, tel_no: null,
    role: 'Administrateur Systeme et Reseau', roles: ['Administrateur Systeme et Reseau'],
    is_superadmin: true, status: 'Active', job_title: null, employment_type: null,
    weekly_hours_target: null, work_profile_incomplete: false, work_profile: null,
    work_profile_start_date: null, mfa_reenrollment_required: false,
    global_session_epoch: 0, membership_version: membershipVersion,
    mfa_factor_id: factorId, mfa_factor_version: factorVersion,
    mfa_verified_at: new Date().toISOString(), mfa_method: 'totp',
  };
}

async function schema(admin) {
  await admin.query(`CREATE DATABASE "${database}"`);
  const db = new Client({ connectionString: `postgresql://${fixtureUser}@${fixtureHost}:${databasePort}/${database}` });
  await db.connect();
  try {
    await db.query(`
      CREATE TABLE public.users (id integer PRIMARY KEY, status text NOT NULL, mfa_reenrollment_required boolean NOT NULL DEFAULT false);
      CREATE TABLE public.cerp_directory_profiles (profile_id uuid PRIMARY KEY, user_id integer NOT NULL UNIQUE REFERENCES public.users(id));
      CREATE TABLE public.cerp_directory_memberships (
        profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id), database_id text NOT NULL,
        is_superadmin boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'Active',
        PRIMARY KEY(profile_id, database_id)
      );
      CREATE TABLE public.user_mfa_factors (id uuid PRIMARY KEY, user_id integer NOT NULL REFERENCES public.users(id), state text NOT NULL, version integer NOT NULL);
      CREATE TABLE public.realtime_session_epochs (user_id integer PRIMARY KEY REFERENCES public.users(id), session_epoch integer NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.erp_audit_logs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id integer, event_type text NOT NULL, action text NOT NULL,
        page_key text, entity_type text, entity_id text, path text, client_session_id text, ip text, user_agent text,
        device_type text, os text, browser text, details jsonb, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.realtime_stream_enqueue_state (stream_id text PRIMARY KEY, next_ordinal bigint NOT NULL, updated_at timestamptz NOT NULL);
      CREATE TABLE public.erp_outbox_events (
        event_key text PRIMARY KEY, aggregate_type text NOT NULL, aggregate_id text NOT NULL, event_type text NOT NULL,
        payload jsonb NOT NULL, correlation_id uuid NOT NULL, status text NOT NULL, available_at timestamptz NOT NULL,
        realtime_stream_id text NOT NULL, realtime_stream_ordinal bigint NOT NULL
      );
      CREATE ROLE ${appUser} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
      GRANT USAGE ON SCHEMA public TO ${appUser};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appUser};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appUser};
    `);
  } finally { await db.end(); }
}

async function seed(db) {
  const users = [1, 2, 3].map(id => ({ id, profile: crypto.randomUUID(), factor: crypto.randomUUID() }));
  for (const user of users) {
    await db.query('INSERT INTO public.users(id,status,mfa_reenrollment_required) VALUES($1,\'Active\',false)', [user.id]);
    await db.query('INSERT INTO public.cerp_directory_profiles(profile_id,user_id) VALUES($1,$2)', [user.profile, user.id]);
    await db.query('INSERT INTO public.cerp_directory_memberships(profile_id,database_id,is_superadmin,version,status) VALUES($1,\'cerp_prod\',$2,1,\'Active\')', [user.profile, user.id !== 3]);
    await db.query('INSERT INTO public.user_mfa_factors(id,user_id,state,version) VALUES($1,$2,\'ACTIVE\',1)', [user.factor, user.id]);
    await db.query('INSERT INTO public.realtime_session_epochs(user_id,session_epoch) VALUES($1,0)', [user.id]);
  }
  return { ownerA: users[0], ownerB: users[1], target: users[2] };
}

async function expectCode(work, code) {
  try { await work(); } catch (error) { if (error?.code === code) return; throw error; }
  throw new Error(`EXPECTED_CODE:${code}`);
}

async function main() {
  assertFixtureUrl(appUrl);
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = appUrl;
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.MFA_ROOT_KEY = crypto.randomBytes(32).toString('base64');
  process.env.AUTH_RATE_LIMIT_HASH_KEY = crypto.randomBytes(48).toString('hex');
  require('ts-node/register/transpile-only');
  const { setProductionSuperadminMembership } = require('../../src/shared-directory/admin.operations');
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const identity = (await admin.query('SELECT current_user actor, inet_server_addr()::text host, inet_server_port() port')).rows[0];
    check('fixture admin identity', identity.actor === fixtureUser && Number(identity.port) === databasePort);
    await schema(admin);
    fixtureAdmin = new Client({ connectionString: `postgresql://${fixtureUser}@${fixtureHost}:${databasePort}/${database}` });
    await fixtureAdmin.connect();
    pool = new Pool({ connectionString: appUrl, max: 6 });
    const appIdentity = (await pool.query('SELECT current_user actor,current_database() database,inet_server_addr()::text host,inet_server_port() port')).rows[0];
    check('fixture app identity', appIdentity.actor === appUser && appIdentity.database === database && Number(appIdentity.port) === databasePort);
    const { ownerA, ownerB, target } = await seed(pool);
    const actorA = actor(ownerA.profile, ownerA.id, ownerA.factor);
    const actorB = actor(ownerB.profile, ownerB.id, ownerB.factor);

    const [first, second] = await Promise.allSettled([
      setProductionSuperadminMembership(pool, actorA, { profile_id: target.profile, is_superadmin: true, expected_version: 1 }),
      setProductionSuperadminMembership(pool, actorB, { profile_id: target.profile, is_superadmin: true, expected_version: 1 }),
    ]);
    check('concurrent same-version mutation has one commit', [first, second].filter(item => item.status === 'fulfilled' && item.value.changed).length === 1);
    check('concurrent same-version mutation rejects stale peer', [first, second].some(item => item.status === 'rejected' && item.reason?.code === 'DIRECTORY_MEMBERSHIP_STALE'));
    check('one canonical audit and outbox event', Number((await pool.query('SELECT count(*)::int n FROM public.erp_audit_logs')).rows[0].n) === 1
      && Number((await pool.query('SELECT count(*)::int n FROM public.erp_outbox_events')).rows[0].n) === 1);

    await expectCode(() => setProductionSuperadminMembership(pool, actorA, { profile_id: target.profile, is_superadmin: true, expected_version: 1 }), 'DIRECTORY_MEMBERSHIP_STALE');
    await expectCode(() => setProductionSuperadminMembership(pool, actorA, { profile_id: ownerA.profile, is_superadmin: false, expected_version: 1 }), 'DIRECTORY_SELF_DEMOTION_FORBIDDEN');
    check('self-demotion is rolled back', (await pool.query('SELECT is_superadmin FROM public.cerp_directory_memberships WHERE profile_id=$1', [ownerA.profile])).rows[0].is_superadmin === true);

    await pool.query('UPDATE public.user_mfa_factors SET state=\'REVOKED\' WHERE id=$1', [ownerB.factor]);
    await expectCode(() => setProductionSuperadminMembership(pool, actorB, { profile_id: target.profile, is_superadmin: false, expected_version: 2 }), 'DIRECTORY_OWNER_REAUTH_REQUIRED');
    check('revoked factor prevents write at locked recheck', (await pool.query('SELECT is_superadmin,version FROM public.cerp_directory_memberships WHERE profile_id=$1', [target.profile])).rows[0].is_superadmin === true);

    await pool.query('UPDATE public.user_mfa_factors SET state=\'REVOKED\' WHERE id=$1', [ownerB.factor]);
    await fixtureAdmin.query(`CREATE FUNCTION public.fixture_remove_actor_factor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      DELETE FROM public.user_mfa_factors WHERE user_id=${ownerA.id}; RETURN NEW; END $$;
      CREATE TRIGGER fixture_last_owner AFTER UPDATE OF is_superadmin ON public.cerp_directory_memberships FOR EACH ROW
      WHEN (OLD.is_superadmin IS DISTINCT FROM NEW.is_superadmin) EXECUTE FUNCTION public.fixture_remove_actor_factor();`);
    await expectCode(() => setProductionSuperadminMembership(pool, actorA, { profile_id: target.profile, is_superadmin: false, expected_version: 2 }), 'LAST_DIRECTORY_OWNER');
    check('last-owner guard rolls back membership and audit', (await pool.query('SELECT is_superadmin FROM public.cerp_directory_memberships WHERE profile_id=$1', [target.profile])).rows[0].is_superadmin === true
      && Number((await pool.query('SELECT count(*)::int n FROM public.erp_audit_logs')).rows[0].n) === 1);

    const report = { result: 'PASS', checks, published_port: port, database_port: databasePort, fixture_only: true, production_changed: false, shared_directory_changed: false };
    await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ result: report.result, checks: checks.length, fixture_only: true }));
  } finally {
    if (pool) await pool.end();
    if (fixtureAdmin) await fixtureAdmin.end();
    try { await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, [database]); } catch {}
    try { await admin.query(`DROP DATABASE IF EXISTS "${database}"`); } catch {}
    await admin.end();
  }
}
main().catch(error => { console.error(JSON.stringify({ result: 'FAIL', code: error?.code ?? 'UNKNOWN', message: String(error?.message ?? 'UNKNOWN').slice(0, 160) })); process.exitCode = 1; });
