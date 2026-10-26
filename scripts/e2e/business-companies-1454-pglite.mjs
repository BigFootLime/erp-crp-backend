import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const runtime = process.env.CERP_PGLITE_NODE_MODULES;
if (!runtime) {
  throw new Error(
    "Set CERP_PGLITE_NODE_MODULES to a temporary node_modules containing @electric-sql/pglite.",
  );
}
const { PGlite } = createRequire(path.join(runtime, "package.json"))(
  "@electric-sql/pglite",
);
const migration = await readFile(
  path.join(root, "db/shared-directory/20261026_business_companies_1454.sql"),
  "utf8",
);
const rollback = await readFile(
  path.join(
    root,
    "db/shared-directory/20261026_business_companies_1454.rollback.sql",
  ),
  "utf8",
);
const verify = await readFile(
  path.join(root, "db/shared-directory/20261026_business_companies_1454.verify.sql"),
  "utf8",
);
const hash = createHash("sha256").update(migration).digest("hex");
const fixtureMigration = migration.replace(
  "IF current_database() !~ '^cerp_directory_[a-f0-9]{32}$' THEN RAISE EXCEPTION 'Business companies registry must run in the private Directory'; END IF;",
  "IF false THEN RAISE EXCEPTION 'fixture-only database-name bypass'; END IF;",
);
const reject = (db, sql, message) =>
  assert.rejects(db.exec(sql), undefined, message);
const db = new PGlite();

try {
  await db.exec(`
    CREATE ROLE cerp_directory_app; CREATE ROLE cerp_app;
    CREATE TABLE public.users(id integer PRIMARY KEY);
    CREATE TABLE public.cerp_directory_profiles(profile_id uuid PRIMARY KEY,user_id integer NOT NULL REFERENCES public.users(id));
    CREATE TABLE public.cerp_directory_memberships(profile_id uuid NOT NULL REFERENCES public.cerp_directory_profiles(profile_id),database_id text NOT NULL CHECK(database_id IN ('cerp_prod','cerp_test') OR database_id~'^cerp_test_[a-f0-9]{32}$'),PRIMARY KEY(profile_id,database_id));
    CREATE TABLE public.erp_audit_logs(entity_type text NOT NULL);
    INSERT INTO public.users VALUES(1);
    INSERT INTO public.cerp_directory_profiles VALUES('11111111-1111-4111-8111-111111111111',1);
  `);
  assert.equal(
    (await db.query("SELECT current_database() AS value")).rows[0].value,
    "template1",
  );
  await db.exec(fixtureMigration);
  await db.exec(verify);
  await db.exec("REVOKE SELECT ON public.cerp_business_companies FROM cerp_directory_app");
  await reject(db, verify, "verification requires every declared permission");
  await db.exec("GRANT SELECT ON public.cerp_business_companies TO cerp_directory_app");
  await db.exec(verify);
  const ec = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const crp = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const insert = (id, code, profile, modules = "'clients'") =>
    db.exec(
      `INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,enabled_module_keys,created_by_user_id,updated_by_user_id) VALUES('${id}','${code}','${code}','${profile}','ACTIVE',ARRAY[${modules}],1,1)`,
    );
  await insert(ec, "EC", "COMMERCIAL");
  await insert(crp, "CRP", "INDUSTRIAL");
  await reject(
    db,
    `INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,created_by_user_id,updated_by_user_id) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','EC','Duplicate','INDUSTRIAL','ACTIVE',1,1)`,
    "duplicate code",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,enabled_module_keys,created_by_user_id,updated_by_user_id) VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd','BAD','Bad','COMMERCIAL','ACTIVE',ARRAY['stock'],1,1)`,
    "commercial stock",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,enabled_module_keys,created_by_user_id,updated_by_user_id) VALUES('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','MOD','Invalid','INDUSTRIAL','ACTIVE',ARRAY['unknown'],1,1)`,
    "unknown module",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,enabled_module_keys,created_by_user_id,updated_by_user_id) VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff','NUL','Null','INDUSTRIAL','ACTIVE',NULL,1,1)`,
    "null modules",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_company_memberships(company_id,profile_id,status,created_by_user_id,updated_by_user_id) VALUES('${ec}','99999999-9999-4999-8999-999999999999','ACTIVE',1,1)`,
    "profile FK",
  );
  await db.exec(
    `INSERT INTO public.cerp_business_company_memberships(company_id,profile_id,status,created_by_user_id,updated_by_user_id) VALUES('${ec}','11111111-1111-4111-8111-111111111111','ACTIVE',1,1)`,
  );
  assert.deepEqual(
    (
      await db.query(
        `SELECT allowed_module_keys FROM public.cerp_business_company_memberships WHERE company_id='${ec}'`,
      )
    ).rows[0].allowed_module_keys,
    [],
    "membership modules default to deny",
  );
  await db.exec(
    `INSERT INTO public.cerp_business_company_instances(company_id,environment,site_id,created_by_user_id,updated_by_user_id) VALUES('${crp}','cerp_prod','cerp_prod',1,1),('${ec}','cerp_prod','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod',1,1);`,
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_company_instances(company_id,environment,site_id,created_by_user_id,updated_by_user_id) VALUES('${ec}','cerp_test','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod',1,1)`,
    "environment suffix",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_company_instances(company_id,environment,site_id,created_by_user_id,updated_by_user_id) VALUES('${crp}','cerp_test','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod',1,1)`,
    "unique site",
  );
  const requestOne = "11111111-1111-4111-8111-111111111119";
  const ticketOne = "1".repeat(64);
  const sourceHash = "2".repeat(64);
  await db.exec(`
    INSERT INTO public.cerp_business_company_switches(
      ticket_hash,request_key,source_session_hash,profile_id,source_site,target_site,
      company_id,environment,global_session_epoch,source_membership_version,
      source_company_membership_version,company_membership_version,
      target_directory_membership_version,expires_at
    ) VALUES(
      '${ticketOne}','${requestOne}','${sourceHash}',
      '11111111-1111-4111-8111-111111111111','cerp_prod',
      'cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod','${ec}','cerp_prod',
      9007199254740993,4,5,6,7,now()+interval '60 seconds'
    );
  `);
  assert.equal(
    (
      await db.query(
        `SELECT global_session_epoch::text AS epoch FROM public.cerp_business_company_switches WHERE ticket_hash='${ticketOne}'`,
      )
    ).rows[0].epoch,
    "9007199254740993",
    "the SQL ticket preserves epochs above JavaScript safe integer range",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_company_switches(ticket_hash,request_key,source_session_hash,profile_id,source_site,target_site,company_id,environment,global_session_epoch,source_membership_version,source_company_membership_version,company_membership_version,target_directory_membership_version,expires_at)
     VALUES('${"3".repeat(64)}','${requestOne}','${sourceHash}','11111111-1111-4111-8111-111111111111','cerp_prod','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod','${ec}','cerp_prod',1,1,1,1,1,now()+interval '60 seconds')`,
    "one source session/request key has one idempotency record",
  );
  await reject(
    db,
    `INSERT INTO public.cerp_business_company_switches(ticket_hash,request_key,source_session_hash,profile_id,source_site,target_site,company_id,environment,global_session_epoch,source_membership_version,source_company_membership_version,company_membership_version,target_directory_membership_version,expires_at)
     VALUES('${"4".repeat(64)}','22222222-2222-4222-8222-222222222229','${"5".repeat(64)}','11111111-1111-4111-8111-111111111111','cerp_prod','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod','${ec}','cerp_prod',1,1,NULL,1,1,now()+interval '60 seconds')`,
    "source company membership version is mandatory",
  );
  await db.exec(
    `UPDATE public.cerp_business_company_switches SET redeemed_at=now(),redeemed_session_hash='${"6".repeat(64)}' WHERE ticket_hash='${ticketOne}'`,
  );
  const redeemedAt = (
    await db.query(
      `SELECT redeemed_at::text AS value FROM public.cerp_business_company_switches WHERE ticket_hash='${ticketOne}'`,
    )
  ).rows[0].value;
  await db.exec(
    `UPDATE public.cerp_business_company_switches SET redeemed_at=coalesce(redeemed_at,now()) WHERE ticket_hash='${ticketOne}'`,
  );
  assert.equal(
    (
      await db.query(
        `SELECT redeemed_at::text AS value FROM public.cerp_business_company_switches WHERE ticket_hash='${ticketOne}'`,
      )
    ).rows[0].value,
    redeemedAt,
    "retry keeps the original redemption timestamp",
  );
  await db.exec(`INSERT INTO public.cerp_business_company_switches(ticket_hash,request_key,source_session_hash,profile_id,source_site,target_site,company_id,environment,global_session_epoch,source_membership_version,source_company_membership_version,company_membership_version,target_directory_membership_version,expires_at)
    VALUES('${"7".repeat(64)}','33333333-3333-4333-8333-333333333339','${"8".repeat(64)}','11111111-1111-4111-8111-111111111111','cerp_prod','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod','${ec}','cerp_prod',1,1,1,1,1,now()-interval '1 second')`);
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS count FROM public.cerp_business_company_switches WHERE expires_at<=now()`,
      )
    ).rows[0].count,
    1,
    "expiry remains an application/helper rejection, not a table CHECK",
  );
  await db.exec("SET ROLE cerp_app");
  await reject(
    db,
    "SELECT * FROM public.cerp_business_companies",
    "cerp_app denied",
  );
  await reject(
    db,
    "SELECT * FROM public.cerp_business_company_switches",
    "cerp_app cannot read switch tickets",
  );
  await db.exec("RESET ROLE");
  await reject(db, rollback, "rollback with data");
  await db.exec(
    "DELETE FROM public.cerp_business_company_switches; DELETE FROM public.cerp_business_company_memberships; DELETE FROM public.cerp_business_company_instances; DELETE FROM public.cerp_business_companies;",
  );
  await db.exec(
    "INSERT INTO public.erp_audit_logs(entity_type) VALUES('business_company_instance')",
  );
  await reject(db, rollback, "rollback with registry audit evidence");
  await db.exec("DELETE FROM public.erp_audit_logs");
  await db.exec(rollback);
  await reject(
    db,
    "INSERT INTO public.cerp_directory_memberships(profile_id,database_id) VALUES('11111111-1111-4111-8111-111111111111','cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_prod')",
    "empty rollback restores the legacy Directory site-id constraint",
  );
  console.log(
    JSON.stringify({ status: "passed", migration_sha256: hash }, null, 2),
  );
} finally {
  await db.close();
}
