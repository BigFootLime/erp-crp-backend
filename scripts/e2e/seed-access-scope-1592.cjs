#!/usr/bin/env node
"use strict";

/*
 * #1592 access-scope fixture for the disposable SOL-05 stack.
 *
 * SOL-05 deliberately boots local authentication only.  The shared Directory
 * has its own authority qualification recipe; do not manufacture a Directory
 * projection or session here.  These accounts exercise the production module
 * gate through normal password login and persisted app_module_user_access rows.
 */

const bcrypt = require("bcryptjs");
const { Client } = require("pg");

const FIXTURE_FLAG = "CERP_E2E_ACCESS_SCOPE_FIXTURE";
const ISOLATED_FLAG = "CERP_E2E_ISOLATED";
const PASSWORD_FLAG = "E2E_PASSWORD";
const EXPECTED_DATABASE = "cerp_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const FIXTURE_USERS = [
  {
    username: "E2E_SCOPE_PLANNING_DEVIS",
    name: "Planning Devis",
    surname: "E2E",
    email: "planning-devis.e2e@invalid.example",
    grants: ["planning", "devis"],
  },
  {
    username: "E2E_SCOPE_PLANNING_ONLY",
    name: "Planning Seulement",
    surname: "E2E",
    email: "planning-only.e2e@invalid.example",
    grants: ["planning"],
  },
];

function assertFixtureEnvironment(env = process.env) {
  if (env[ISOLATED_FLAG] !== "1" || env[FIXTURE_FLAG] !== "1") {
    throw new Error(`${ISOLATED_FLAG}=1 and ${FIXTURE_FLAG}=1 are required`);
  }
  if (env.CERP_SHARED_DIRECTORY_ENABLED === "true") {
    throw new Error("SOL-05 access-scope fixture only supports its local isolated authentication mode");
  }
  if (!env[PASSWORD_FLAG]) throw new Error(`${PASSWORD_FLAG} is required`);

  let url;
  try {
    url = new URL(env.DATABASE_URL ?? "");
  } catch {
    throw new Error("DATABASE_URL must be a valid isolated PostgreSQL URL");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(hostname) || !url.port || url.pathname !== `/${EXPECTED_DATABASE}`) {
    throw new Error("access-scope fixture refuses non-loopback, implicit-port, or non-cerp_test databases");
  }
  const isolatedPort = env.CERP_E2E_DB_PORT;
  if (!/^\d{2,5}$/.test(isolatedPort ?? "") || url.port !== isolatedPort) {
    throw new Error("DATABASE_URL must use the explicit CERP_E2E_DB_PORT isolated port");
  }
  return url;
}

async function requireModuleCatalog(client) {
  const modules = await client.query(
    `SELECT module_key
       FROM public.app_modules
      WHERE is_active = true
      ORDER BY module_key`
  );
  const available = new Set(modules.rows.map((row) => row.module_key));
  for (const moduleKey of ["planning", "devis"]) {
    if (!available.has(moduleKey)) throw new Error(`access-scope fixture requires active ${moduleKey} module`);
  }
}

async function seedUser(client, user, passwordHash, actorId) {
  const result = await client.query(
    `INSERT INTO public.users (username,password,name,surname,email,role,status,is_superadmin)
     VALUES ($1,$2,$3,$4,$5,'Employee','Active',false)
     ON CONFLICT (username) DO UPDATE SET
       password=EXCLUDED.password,
       name=EXCLUDED.name,
       surname=EXCLUDED.surname,
       email=EXCLUDED.email,
       role='Employee',
       status='Active',
       is_superadmin=false
     RETURNING id,is_superadmin,status`,
    [user.username, passwordHash, user.name, user.surname, user.email]
  );
  const account = result.rows[0];
  if (!account || account.is_superadmin || account.status !== "Active") {
    throw new Error(`access-scope fixture could not activate ${user.username}`);
  }
  await client.query(
    `INSERT INTO public.user_role_assignments (user_id,role_key,assigned_by)
     VALUES ($1,'Employee',$2)
     ON CONFLICT (user_id,role_key) DO NOTHING`,
    [account.id, actorId]
  );

  // Persist denials for every non-protected module first.  The test accounts
  // then receive only their named grants, so a newly catalogued module starts
  // closed even if its state is changed between isolated runs.
  await client.query(
    `INSERT INTO public.app_module_user_access (user_id,module_key,access,updated_by)
     SELECT $1,module_key,'DENIED',$2
       FROM public.app_modules
      WHERE is_active = true AND is_protected = false
     ON CONFLICT (user_id,module_key) DO UPDATE SET
       access='DENIED',updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [account.id, actorId]
  );
  await client.query(
    `UPDATE public.app_module_user_access
        SET access='GRANTED',updated_by=$2,updated_at=now()
      WHERE user_id=$1 AND module_key = ANY($3::text[])`,
    [account.id, actorId, user.grants]
  );

  const grants = await client.query(
    `SELECT module_key,access
       FROM public.app_module_user_access
      WHERE user_id=$1
      ORDER BY module_key`,
    [account.id]
  );
  const granted = new Set(grants.rows.filter((row) => row.access === "GRANTED").map((row) => row.module_key));
  const unexpected = [...granted].filter((moduleKey) => !user.grants.includes(moduleKey));
  if (unexpected.length || user.grants.some((moduleKey) => !granted.has(moduleKey))) {
    throw new Error(`access-scope fixture grants are not closed for ${user.username}`);
  }
}

async function main() {
  const url = assertFixtureEnvironment();
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const identity = await client.query("SELECT current_database() AS database");
    if (identity.rows[0]?.database !== EXPECTED_DATABASE) throw new Error("access-scope fixture database identity mismatch");
    await client.query("BEGIN");
    const keenan = await client.query(
      `SELECT id,is_superadmin,status
         FROM public.users
        WHERE username='KEENAN'
        FOR UPDATE`
    );
    const actor = keenan.rows[0];
    if (!actor || actor.is_superadmin !== true || actor.status !== "Active") {
      throw new Error("KEENAN must remain the active isolated SuperAdmin fixture");
    }
    await requireModuleCatalog(client);
    const passwordHash = await bcrypt.hash(process.env[PASSWORD_FLAG], 10);
    for (const user of FIXTURE_USERS) await seedUser(client, user, passwordHash, actor.id);
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify({
      seeded: true,
      auth_mode: "local-isolated",
      shared_directory_qualified: false,
      users: FIXTURE_USERS.map(({ username, grants }) => ({ username, grants })),
      superadmin: "KEENAN",
    })}\n`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { assertFixtureEnvironment };
