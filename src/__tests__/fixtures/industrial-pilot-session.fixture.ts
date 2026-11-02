import { issueSessionToken } from "../../module/auth/domain/session-token";
import pool from "../../config/database";
import { findAuthenticatedAccountState } from "../../module/auth/repository/auth.repository";

/** Issue a short-lived workshop session for the isolated fixture account. */
export async function signPilotFixtureSession(actorId: number) {
  const target = new URL(
    process.env.DATABASE_URL ?? "postgres://localhost/off",
  );
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.CERP_E2E_ISOLATED !== "1" ||
    target.pathname !== "/cerp_test" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  ) {
    throw new Error(
      "Pilot session fixture requires isolated loopback cerp_test.",
    );
  }
  const user = (
    await pool.query<{
      id: number;
      username: string;
      email: string | null;
      role: string;
    }>(
      "SELECT id,username,email,role FROM public.users WHERE id=$1 AND status='Active'",
      [actorId],
    )
  ).rows[0];
  if (!user) throw new Error("Missing active pilot fixture user.");
  let state = await findAuthenticatedAccountState(actorId);
  if (state?.mfa_required && !state.mfa_factor_id) {
    await pool.query(
      `INSERT INTO public.user_mfa_factors
      (user_id,state,encrypted_secret,encryption_iv,encryption_tag,key_id,enrolled_at,device_label)
      VALUES($1,'ACTIVE',decode(repeat('00',16),'hex'),decode(repeat('00',12),'hex'),
        decode(repeat('00',16),'hex'),'isolated-test-key',now(),'Recette isolée') ON CONFLICT DO NOTHING`,
      [actorId],
    );
    state = await findAuthenticatedAccountState(actorId);
  }
  if (!state || (state.mfa_required && !state.mfa_factor_id))
    throw new Error("Pilot session is unavailable.");
  const roles = (await pool.query<{role_key:string}>(
    "SELECT role_key FROM public.user_role_assignments WHERE user_id=$1 ORDER BY role_key", [actorId],
  )).rows.map(r => r.role_key);
  return issueSessionToken({ ...user, roles, realtime_session_epoch: state.session_epoch },
    state.mfa_factor_id && state.mfa_factor_version != null
      ? {factorId: state.mfa_factor_id, factorVersion: state.mfa_factor_version, verifiedAt: new Date(), method: "totp"}
      : undefined);
}
