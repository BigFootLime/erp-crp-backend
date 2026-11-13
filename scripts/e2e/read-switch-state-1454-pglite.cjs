/* Real SQL execution for both readSwitchState branches; no query mock. */
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const runtime = process.env.CERP_PGLITE_NODE_MODULES;
if (!runtime) throw new Error("Set CERP_PGLITE_NODE_MODULES");
const external = createRequire(path.join(runtime, "package.json"));
const { PGlite } = external("@electric-sql/pglite");
require("ts-node/register/transpile-only");
const {
  readSwitchState,
} = require("../../src/shared-directory/business-company-switch.repository");
(async () => {
  const db = new PGlite(),
    company = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    profile = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    site = "cerp_company_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_test",
    token = "c".repeat(64);
  try {
    await db.exec(
      `CREATE TABLE users(id int primary key,status text,mfa_reenrollment_required boolean);CREATE TABLE cerp_directory_profiles(profile_id uuid primary key,user_id int);CREATE TABLE cerp_business_companies(company_id uuid primary key,code text,name text,profile text,status text,enabled_module_keys text[],enabled_commercial_projection_capabilities text[]);CREATE TABLE cerp_business_company_memberships(company_id uuid,profile_id uuid,status text,denied_module_keys text[],enabled_commercial_projection_capabilities text[],version int);CREATE TABLE cerp_business_company_instances(company_id uuid,environment text,site_id text,active boolean,version int);CREATE TABLE cerp_directory_memberships(profile_id uuid,database_id text,status text,version int);CREATE TABLE cerp_directory_sessions(profile_id uuid,token_hash text,database_id text,expires_at timestamptz,membership_version int,global_session_epoch bigint,mfa_factor_id uuid,mfa_factor_version int,mfa_verified_at timestamptz,mfa_method text,tablet_device_id uuid,tablet_pin_version int);CREATE TABLE realtime_session_epochs(user_id int,session_epoch bigint);`,
    );
    await db.exec(
      `INSERT INTO users VALUES(7,'Active',false);INSERT INTO cerp_directory_profiles VALUES('${profile}',7);INSERT INTO realtime_session_epochs VALUES(7,9);INSERT INTO cerp_business_companies VALUES('${company}','ACME','Acme','INDUSTRIAL','ACTIVE',ARRAY['clients'],ARRAY[]::text[]);INSERT INTO cerp_business_company_memberships VALUES('${company}','${profile}','ACTIVE',ARRAY[]::text[],ARRAY[]::text[],4);INSERT INTO cerp_business_company_instances VALUES('${company}','cerp_test','${site}',true,5);INSERT INTO cerp_directory_memberships VALUES('${profile}','${site}','Active',6);`,
    );
    await db.exec(
      "ALTER TABLE cerp_business_company_memberships ADD COLUMN allowed_module_keys text[] NOT NULL DEFAULT '{}'; UPDATE cerp_business_company_memberships SET allowed_module_keys=ARRAY['clients'];",
    );
    const direct = await readSwitchState(db, {
      profileId: profile,
      companyId: company,
      environment: "cerp_test",
    });
    assert.equal(direct.site_id, site);
    assert.equal(direct.company_membership_version, 4);
    assert.deepEqual(direct.allowed_module_keys, ["clients"]);
    await db.exec(
      `INSERT INTO cerp_directory_sessions VALUES('${profile}','${token}','${site}',now()+interval '1 hour',6,9,NULL,NULL,NULL,NULL,NULL,NULL);`,
    );
    const switched = await readSwitchState(db, {
      profileId: profile,
      companyId: company,
      environment: "cerp_test",
      sourceSite: site,
      sourceSessionHash: token,
    });
    assert.equal(switched.source_company_membership_version, 4);
    assert.equal(switched.global_session_epoch, 9);
    await db.exec("UPDATE cerp_directory_memberships SET status='Inactive'");
    assert.equal(
      await readSwitchState(db, {
        profileId: profile,
        companyId: company,
        environment: "cerp_test",
        sourceSite: site,
        sourceSessionHash: token,
      }),
      null,
    );
    console.log(
      JSON.stringify({
        status: "passed",
        branches: ["direct", "source-session"],
      }),
    );
  } finally {
    await db.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
