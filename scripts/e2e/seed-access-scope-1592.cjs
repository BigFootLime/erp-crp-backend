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
const ACCESS_SCOPE_OF_ID = 9201592;
const ACCESS_SCOPE_OF_NUMBER = "OF-E2E-SCOPE-1592";
const ACCESS_SCOPE_OF_OPERATION_ID = "92000000-0000-4000-8000-000000001592";
const FINANCE_CAPABILITIES = ["finance.issue", "finance.validate"];

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

// This is an E2E fixture matrix, deliberately keyed by account rather than by
// its descriptive job title.  A new fixture account starts closed.
const ACCOUNT_ACCESS = [
  { username: "E2E_STANDARD", grants: [] },
  { username: "E2E_SALES", grants: [] },
  { username: "E2E_PLANNER", grants: ["production", "planning"] },
  { username: "E2E_OPERATOR", grants: ["production"] },
  { username: "E2E_QUALITY", grants: ["ged"] },
  { username: "E2E_PURCHASING", grants: [] },
  { username: "E2E_ACCOUNTANT", grants: ["facturation"] },
  ...FIXTURE_USERS.map(({ username, grants }) => ({ username, grants })),
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

  return account.id;
}

async function applyAccountAccess(client, username, grants, actorId) {
  const account = (await client.query(
    `SELECT id,is_superadmin,status FROM public.users WHERE username=$1 FOR UPDATE`,
    [username]
  )).rows[0];
  if (!account || account.is_superadmin || account.status !== "Active") {
    throw new Error(`access-scope fixture requires active non-superadmin ${username}`);
  }
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
    [account.id, actorId, grants]
  );

  const accessRows = await client.query(
    `SELECT module_key,access
       FROM public.app_module_user_access
      WHERE user_id=$1
      ORDER BY module_key`,
    [account.id]
  );
  const granted = new Set(accessRows.rows.filter((row) => row.access === "GRANTED").map((row) => row.module_key));
  const unexpected = [...granted].filter((moduleKey) => !grants.includes(moduleKey));
  if (unexpected.length || grants.some((moduleKey) => !granted.has(moduleKey))) {
    throw new Error(`access-scope fixture grants are not closed for ${username}`);
  }
}

async function normalizeSensitiveCapabilities(client, actorId) {
  const accountant = (await client.query(
    `SELECT id FROM public.users WHERE username='E2E_ACCOUNTANT' AND status='Active' AND is_superadmin=false FOR UPDATE`
  )).rows[0];
  if (!accountant) throw new Error("access-scope fixture requires active E2E_ACCOUNTANT");
  // seed-mfa-sol32 predates the narrow fixture contract and grants broad
  // finance plus audit rights. The immediate second invocation restores only
  // the two powers exercised by the real invoice validation and issuance
  // journey.
  await client.query(
    `UPDATE public.app_user_sensitive_capabilities
        SET granted=false,updated_by=$2,updated_at=now()
      WHERE user_id=$1`,
    [accountant.id, actorId]
  );
  for (const capability of FINANCE_CAPABILITIES) {
    await client.query(
      `INSERT INTO public.app_user_sensitive_capabilities(user_id,capability,granted,updated_by)
       VALUES($1,$2,true,$3)
       ON CONFLICT(user_id,capability) DO UPDATE SET granted=true,updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [accountant.id, capability, actorId]
    );
  }
  for (const username of ["E2E_SALES", "E2E_PURCHASING"]) {
    await client.query(
      `UPDATE public.app_user_sensitive_capabilities
          SET granted=false,updated_by=$2,updated_at=now()
        WHERE user_id=(SELECT id FROM public.users WHERE username=$1)`,
      [username, actorId]
    );
    const residual = await client.query(
      `SELECT capability
         FROM public.app_user_sensitive_capabilities
        WHERE user_id=(SELECT id FROM public.users WHERE username=$1)
          AND granted=true
        ORDER BY capability`,
      [username]
    );
    if (residual.rowCount !== 0) {
      throw new Error(`${username} retains unexpected sensitive capabilities: ${residual.rows.map((row) => row.capability).join(", ")}`);
    }
  }
  const granted = await client.query(
    `SELECT capability
       FROM public.app_user_sensitive_capabilities
      WHERE user_id=$1 AND granted=true
      ORDER BY capability`,
    [accountant.id]
  );
  const actualCapabilities = granted.rows.map((row) => row.capability).sort();
  const expectedCapabilities = [...FINANCE_CAPABILITIES].sort();
  if (JSON.stringify(actualCapabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new Error(
      `E2E_ACCOUNTANT sensitive capabilities are not limited to invoice validation and issuance: ${actualCapabilities.join(", ") || "(none)"}`
    );
  }
}

async function assertAccountantMfaWhenRequested(client) {
  if (process.env.CERP_E2E_ACCESS_SCOPE_REQUIRE_MFA !== "1") return;
  const factor = await client.query(
    `SELECT 1
       FROM public.user_mfa_factors f
       JOIN public.users u ON u.id=f.user_id
      WHERE u.username='E2E_ACCOUNTANT' AND f.state='ACTIVE'
      LIMIT 1`
  );
  if (factor.rowCount !== 1) throw new Error("E2E_ACCOUNTANT requires an active MFA factor for the finance fixture");
}

async function resetPlanningOf(client, actorId) {
  await client.query(
    `INSERT INTO public.ordres_fabrication(
       id,numero,client_id,piece_technique_id,piece_technique_version_id,quantite_lancee,quantite_bonne,quantite_rebut,
       statut,priority,date_lancement_prevue,date_fin_prevue,technical_readiness,created_by,updated_by
     ) VALUES(
       $1,$2,'901','21000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000001',1,0,0,
       'PLANIFIE','NORMAL',current_date,current_date + 14,'VALIDATED',$3,$3
     ) ON CONFLICT(id) DO UPDATE SET
       numero=EXCLUDED.numero,client_id=EXCLUDED.client_id,piece_technique_id=EXCLUDED.piece_technique_id,
       piece_technique_version_id=EXCLUDED.piece_technique_version_id,quantite_lancee=1,quantite_bonne=0,quantite_rebut=0,
       statut='PLANIFIE',priority='NORMAL',date_lancement_prevue=current_date,date_fin_prevue=current_date + 14,
       technical_readiness='VALIDATED',updated_by=EXCLUDED.updated_by,updated_at=now()`,
    [ACCESS_SCOPE_OF_ID, ACCESS_SCOPE_OF_NUMBER, actorId]
  );
  // The post-primary reset owns this OF.  Removing only its events makes the
  // Planning backlog visible again without affecting the primary suite data.
  await client.query("DELETE FROM public.planning_events WHERE of_id=$1", [ACCESS_SCOPE_OF_ID]);
  await client.query(
    `INSERT INTO public.of_operations(
       id,of_id,phase,designation,poste_id,machine_id,hourly_rate_applied,tp,tf_unit,qte,coef,temps_total_planned,status
     ) VALUES(
       $1,$2,10,'Usinage dédié accès #1592','24000000-0000-4000-8000-000000000001','27000000-0000-4000-8000-000000000001',
       50,0.1,0.25,1,1,0.35,'TODO'
     ) ON CONFLICT(of_id,phase) DO UPDATE SET
       designation=EXCLUDED.designation,poste_id=EXCLUDED.poste_id,machine_id=EXCLUDED.machine_id,
       hourly_rate_applied=EXCLUDED.hourly_rate_applied,tp=EXCLUDED.tp,tf_unit=EXCLUDED.tf_unit,qte=1,coef=1,
       temps_total_planned=EXCLUDED.temps_total_planned,temps_total_real=0,status='TODO',started_at=NULL,ended_at=NULL,updated_at=now()`,
    [ACCESS_SCOPE_OF_OPERATION_ID, ACCESS_SCOPE_OF_ID]
  );
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
    for (const { username, grants } of ACCOUNT_ACCESS) await applyAccountAccess(client, username, grants, actor.id);
    await normalizeSensitiveCapabilities(client, actor.id);
    await assertAccountantMfaWhenRequested(client);
    const resetPlanningOfEnabled = process.env.CERP_E2E_ACCESS_SCOPE_RESET_OF === "1";
    if (resetPlanningOfEnabled) await resetPlanningOf(client, actor.id);
    await client.query("COMMIT");
    process.stdout.write(`${JSON.stringify({
      seeded: true,
      auth_mode: "local-isolated",
      shared_directory_qualified: false,
      users: FIXTURE_USERS.map(({ username, grants }) => ({ username, grants })),
      superadmin: "KEENAN",
      ...(resetPlanningOfEnabled ? { planning_of: { id: ACCESS_SCOPE_OF_ID, number: ACCESS_SCOPE_OF_NUMBER } } : {}),
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
