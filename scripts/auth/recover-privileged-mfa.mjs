import process from "node:process";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const usernameArg = process.argv.find((value) => value.startsWith("--username="));
const username = usernameArg?.slice("--username=".length).trim().toUpperCase() ?? "";
const apply = process.argv.includes("--apply");
const reason = process.env.MFA_RECOVERY_REASON?.trim() ?? "";
const approval = process.env.MFA_RECOVERY_APPROVAL?.trim() ?? "";
const expectedApproval = `SOL32:${username}:${new Date().toISOString().slice(0, 10)}`;

if (!username || !/^[A-Z0-9._-]{3,80}$/.test(username)) {
  throw new Error("Pass --username=ACCOUNT with a canonical privileged username");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query(
    `SELECT u.id, u.username, u.status, u.is_superadmin,
            f.id::text AS factor_id, f.version AS factor_version
       FROM public.users u
       LEFT JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.state='ACTIVE'
      WHERE u.username=$1`,
    [username],
  );
  const user = rows[0];
  if (!user || user.is_superadmin !== true) throw new Error("Privileged account not found");
  process.stdout.write(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    database: new URL(process.env.DATABASE_URL).pathname.replace(/^\//u, ""),
    username: user.username,
    status: user.status,
    activeFactor: Boolean(user.factor_id),
    factorVersion: user.factor_version ?? null,
    requiredApproval: expectedApproval,
  }, null, 2) + "\n");
  if (!apply) process.exit(0);
  if (approval !== expectedApproval) throw new Error("MFA_RECOVERY_APPROVAL does not match the dated approval token");
  if (reason.length < 12 || reason.length > 500) throw new Error("MFA_RECOVERY_REASON must contain 12 to 500 characters");
  if (!user.factor_id) throw new Error("No active factor to recover");

  await client.query("BEGIN");
  const locked = await client.query(
    `SELECT u.id, f.id::text AS factor_id, f.version
       FROM public.users u
       JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.state='ACTIVE'
      WHERE u.id=$1 AND u.is_superadmin IS TRUE
      FOR UPDATE OF u, f`,
    [user.id],
  );
  if (!locked.rows[0]) throw new Error("Factor changed since dry-run");
  await client.query(
    `UPDATE public.user_mfa_factors
        SET state='REVOKED', revoked_at=now(), updated_at=now()
      WHERE id=$1 AND state='ACTIVE'`,
    [user.factor_id],
  );
  await client.query(
    `INSERT INTO public.realtime_session_epochs(user_id, session_epoch, updated_at)
     VALUES ($1,1,now())
     ON CONFLICT (user_id) DO UPDATE
       SET session_epoch=public.realtime_session_epochs.session_epoch+1, updated_at=now()`,
    [user.id],
  );
  await client.query(
    `INSERT INTO public.erp_audit_logs
       (user_id,event_type,action,page_key,entity_type,entity_id,path,details)
     VALUES ($1,'ACTION','AUTH_MFA_OUT_OF_BAND_RECOVERY','auth-mfa','user_mfa_factor',$2,
             'cli:recover-privileged-mfa',$3::jsonb)`,
    [
      user.id,
      String(user.id),
      JSON.stringify({
        factor_id: user.factor_id,
        factor_version: user.factor_version,
        reason,
        approval: expectedApproval,
        next_action: "Password login must enroll a new TOTP factor",
      }),
    ],
  );
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ applied: true, username, sessionsRevoked: true, nextAction: "re-enroll-at-login" }) + "\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
