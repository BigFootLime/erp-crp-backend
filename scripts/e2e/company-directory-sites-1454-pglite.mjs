import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const runtime = process.env.CERP_PGLITE_NODE_MODULES;
if (!runtime) throw new Error("Set CERP_PGLITE_NODE_MODULES");
const { PGlite } = createRequire(path.join(runtime, "package.json"))(
  "@electric-sql/pglite",
);
const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  ),
  sql = await readFile(
    path.join(
      root,
      "db/company-sites/20261026_company_directory_sites_1454.sql",
    ),
    "utf8",
  );
const fixture = sql.replace(
  "IF current_database() !~ '^cerp_company_[a-f0-9]{32}_(prod|test)$' THEN RAISE EXCEPTION 'Company directory site patch refused on this database'; END IF;",
  "IF false THEN RAISE EXCEPTION 'fixture-only name bypass'; END IF;",
);
assert.notEqual(
  fixture,
  sql,
  "Fixture must replace only the explicit database-name guard",
);
const db = new PGlite();
try {
  await db.exec(
    "CREATE ROLE cerp_app;CREATE TABLE users(id integer primary key);CREATE TABLE operator_device_sessions(id integer primary key);",
  );
  await assert.rejects(db.exec(sql), /Company directory site patch refused/);
  await db.exec("ROLLBACK");
  await db.exec(fixture);
  assert.equal(
    (
      await db.query(
        "SELECT to_regclass('public.cerp_directory_projection_state')::text AS v",
      )
    ).rows[0].v,
    "cerp_directory_projection_state",
  );
  assert.equal(
    (
      await db.query(
        "SELECT has_table_privilege('cerp_app','public.cerp_directory_approved_actor_bindings','INSERT') AS allowed",
      )
    ).rows[0].allowed,
    false,
  );
  await db.exec("INSERT INTO users(id) VALUES(1)");
  await db.exec("CREATE TABLE public.app_modules(module_key text PRIMARY KEY)");
  const policySql = await readFile(
    path.join(root, "db/patches/20261026_company_policy_projections_1454.sql"),
    "utf8",
  );
  await db.exec(policySql);
  await db.query(
    "INSERT INTO public.cerp_company_policy_projections(profile_id,company_id,environment,target_site,company_version,membership_version,instance_version,policy_hash) VALUES($1,$2,'cerp_test',$3,1,1,1,$4)",
    [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "cerp_company_22222222222242228222222222222222_test",
      "a".repeat(64),
    ],
  );
  await assert.rejects(
    db.query(
      "INSERT INTO public.cerp_company_policy_projections(profile_id,company_id,environment,target_site,company_version,membership_version,instance_version,policy_hash) VALUES($1,$2,'cerp_prod',$3,1,1,1,$4)",
      [
        "33333333-3333-4333-8333-333333333333",
        "22222222-2222-4222-8222-222222222222",
        "cerp_company_22222222222242228222222222222222_test",
        "a".repeat(64),
      ],
    ),
    /check constraint/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT has_table_privilege('cerp_app','public.cerp_company_policy_projections','DELETE') AS allowed",
      )
    ).rows[0].allowed,
    false,
  );
  const policyRollback = await readFile(
    path.join(
      root,
      "db/patches/support/20261026_company_policy_projections_1454.rollback.sql",
    ),
    "utf8",
  );
  await assert.rejects(db.exec(policyRollback), /inspected restoration plan/);
  await db.exec("ROLLBACK");
  await db.exec("DELETE FROM public.cerp_company_policy_projections");
  await db.exec(policyRollback);
  await assert.rejects(
    db.query(
      "INSERT INTO cerp_directory_projection_state(profile_id,user_id,source_user_id,global_session_epoch,membership_version,mfa_factor_id,mfa_factor_version) VALUES($1,1,7,0,1,$2,NULL)",
      [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    ),
    /check constraint/,
  );
  await db.query(
    "INSERT INTO cerp_directory_projection_state(profile_id,user_id,source_user_id,global_session_epoch,membership_version,mfa_factor_id,mfa_factor_version) VALUES($1,1,7,0,1,NULL,NULL)",
    ["11111111-1111-4111-8111-111111111111"],
  );
  const rollback = await readFile(
    path.join(
      root,
      "db/company-sites/20261026_company_directory_sites_1454.rollback.sql",
    ),
    "utf8",
  );
  await assert.rejects(db.exec(rollback), /rollback refused/);
  await db.exec("ROLLBACK");
  await db.exec("DELETE FROM cerp_directory_projection_state");
  await db.exec(rollback);
  console.log(
    JSON.stringify({
      status: "passed",
      source_sha256: createHash("sha256").update(sql).digest("hex"),
      guard:
        "source guard rejects template1; fixture-only name bypass for DDL, assurance, privileges and rollback tests",
    }),
  );
} finally {
  await db.close();
}
