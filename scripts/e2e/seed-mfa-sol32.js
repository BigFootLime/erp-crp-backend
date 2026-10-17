const bcrypt = require("bcryptjs");
const { Client } = require("pg");

const { encryptMfaSecret } = require("../../dist/module/auth/domain/mfa.js");

async function main() {
  if (process.env.CERP_E2E_ISOLATED !== "1") throw new Error("MFA fixtures require the isolated E2E stack");
  const secret = process.env.E2E_MFA_SECRET;
  const password = process.env.E2E_PASSWORD;
  if (!secret || !password) throw new Error("E2E_MFA_SECRET and E2E_PASSWORD are required");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if ((await client.query("SELECT current_database() AS name")).rows[0].name !== "cerp_test") throw new Error("MFA fixtures refuse this database");
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT id FROM public.users WHERE username='KEENAN' FOR UPDATE`);
    const keenan = rows[0];
    if (!keenan) throw new Error("KEENAN fixture missing");
    const encrypted = encryptMfaSecret(secret);
    await client.query(`UPDATE public.user_mfa_factors SET state='REVOKED', revoked_at=now(), updated_at=now() WHERE user_id=$1 AND state<>'REVOKED'`, [keenan.id]);
    await client.query(
      `INSERT INTO public.user_mfa_factors
         (id,user_id,state,encrypted_secret,encryption_iv,encryption_tag,key_id,version,enrolled_at)
       VALUES ('32000000-0000-4000-8000-000000000001',$1,'ACTIVE',$2,$3,$4,$5,1,now())`,
      [keenan.id, encrypted.encrypted, encrypted.iv, encrypted.tag, encrypted.keyId],
    );

    const passwordHash = await bcrypt.hash(password, 10);
    const adminResult = await client.query(
      `INSERT INTO public.users(username,password,name,surname,email,role,status,is_superadmin)
       VALUES ('SOL32ADMIN',$1,'SOL32','Admin','sol32-admin@invalid.example','Administrateur Systeme et Reseau','Active',true)
       ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password,status='Active',is_superadmin=true
       RETURNING id`,
      [passwordHash],
    );
    await client.query(
      `INSERT INTO public.user_role_assignments(user_id,role_key,assigned_by)
       VALUES ($1,'Administrateur Systeme et Reseau',$2)
       ON CONFLICT (user_id,role_key) DO NOTHING`,
      [adminResult.rows[0].id, keenan.id],
    );
    // Explicit fixture accounts, not privileges inferred from their job titles.
    // Ordinary E2E_STANDARD intentionally keeps no sensitive grants.
    const capabilities = require("../../dist/module/access-control/domain/sensitive-capabilities.js").SENSITIVE_CAPABILITIES.filter(key => key.startsWith("finance.") || key === "audit.read");
    for (const username of ["E2E_SALES", "E2E_ACCOUNTANT", "E2E_PURCHASING"]) {
      const target = (await client.query("SELECT id FROM users WHERE username=$1", [username])).rows[0];
      if (!target) throw new Error("Sensitive fixture account missing");
      await client.query(`UPDATE user_mfa_factors SET state='REVOKED',revoked_at=now() WHERE user_id=$1 AND state<>'REVOKED'`, [target.id]);
      await client.query(`INSERT INTO user_mfa_factors(user_id,state,encrypted_secret,encryption_iv,encryption_tag,key_id,version,enrolled_at) VALUES($1,'ACTIVE',$2,$3,$4,$5,1,now())`, [target.id,encrypted.encrypted,encrypted.iv,encrypted.tag,encrypted.keyId]);
      for (const capability of capabilities) await client.query(`INSERT INTO app_user_sensitive_capabilities(user_id,capability,granted,updated_by) VALUES($1,$2,true,$3) ON CONFLICT(user_id,capability) DO UPDATE SET granted=true`, [target.id,capability,keenan.id]);
    }
    await client.query("COMMIT");
    process.stdout.write(JSON.stringify({ seeded: true, activeFactorUser: "KEENAN", enrollmentUser: "SOL32ADMIN" }) + "\n");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
