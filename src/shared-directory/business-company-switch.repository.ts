import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Db = Pool | PoolClient;
export const switchHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export type SwitchState = {
  company_id: string;
  code: string;
  name: string;
  profile: string;
  enabled_module_keys: string[];
  company_projection_capabilities: string[];
  denied_module_keys: string[];
  allowed_module_keys: string[];
  membership_projection_capabilities: string[];
  environment: "cerp_prod" | "cerp_test";
  site_id: string;
  company_membership_version: number;
  source_company_membership_version: number;
  target_directory_membership_version: number;
  source_membership_version: number;
  global_session_epoch: number;
  source_session_expires_at: string | null;
  profile_id: string;
  source_user_id: number;
  mfa_factor_id: string | null;
  mfa_factor_version: number | null;
  mfa_verified_at: string | null;
  mfa_method: "totp" | "recovery_code" | null;
  tablet_device_id: string | null;
  tablet_pin_version: number | null;
};

/** Reads only a live, active company grant and its registered tenant instance. */
export async function readSwitchState(
  db: Db,
  params: {
    profileId: string;
    companyId: string;
    environment: "cerp_prod" | "cerp_test";
    sourceSite?: string;
    sourceSessionHash?: string;
  },
): Promise<SwitchState | null> {
  const sourceJoin = params.sourceSessionHash
    ? `JOIN public.cerp_directory_sessions s ON s.profile_id=p.profile_id AND s.token_hash=$4 AND s.database_id=$5 AND s.expires_at>now()
 JOIN public.cerp_directory_memberships source_directory_membership ON source_directory_membership.profile_id=s.profile_id AND source_directory_membership.database_id=s.database_id AND source_directory_membership.status='Active' AND source_directory_membership.version=s.membership_version
 JOIN public.cerp_business_company_instances source_instance ON source_instance.site_id=$5 AND source_instance.active
 JOIN public.cerp_business_companies source_company ON source_company.company_id=source_instance.company_id AND source_company.status='ACTIVE'
 JOIN public.cerp_business_company_memberships source_company_membership ON source_company_membership.company_id=source_instance.company_id AND source_company_membership.profile_id=p.profile_id AND source_company_membership.status='ACTIVE'`
    : "LEFT JOIN public.cerp_directory_sessions s ON false LEFT JOIN public.cerp_business_company_memberships source_company_membership ON false";
  const args = params.sourceSessionHash
    ? [
        params.profileId,
        params.companyId,
        params.environment,
        params.sourceSessionHash,
        params.sourceSite!,
      ]
    : [params.profileId, params.companyId, params.environment];
  const sql = `SELECT c.company_id::text,c.code,c.name,c.profile,c.enabled_module_keys,c.enabled_commercial_projection_capabilities AS company_projection_capabilities,m.allowed_module_keys,m.denied_module_keys,m.enabled_commercial_projection_capabilities AS membership_projection_capabilities,i.environment,i.site_id,m.version AS company_membership_version,coalesce(source_company_membership.version,0) AS source_company_membership_version,target.version AS target_directory_membership_version,
 coalesce(s.membership_version,0) AS source_membership_version,coalesce(s.global_session_epoch,0) AS global_session_epoch,s.expires_at::text AS source_session_expires_at,p.profile_id::text,p.user_id AS source_user_id,
 s.mfa_factor_id::text,s.mfa_factor_version,s.mfa_verified_at::text,s.mfa_method,s.tablet_device_id::text,s.tablet_pin_version
 FROM public.cerp_business_companies c JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id
 JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id AND i.environment=$3
 JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id
 ${sourceJoin} JOIN public.cerp_directory_memberships target ON target.profile_id=p.profile_id AND target.database_id=i.site_id
 WHERE p.profile_id=$1::uuid AND c.company_id=$2::uuid AND c.status='ACTIVE' AND m.status='ACTIVE' AND i.active
 AND target.status='Active' AND u.status='Active' AND NOT u.mfa_reenrollment_required
 AND (s.profile_id IS NULL OR (s.membership_version=(SELECT version FROM public.cerp_directory_memberships sm WHERE sm.profile_id=p.profile_id AND sm.database_id=s.database_id) AND s.global_session_epoch=coalesce((SELECT session_epoch FROM public.realtime_session_epochs WHERE user_id=u.id),0)))`;
  const row = (await db.query<SwitchState>(sql, args)).rows[0];
  if (!row) return null;
  const epoch = Number(row.global_session_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error("DIRECTORY_SESSION_REJECTED");
  return {
    ...row,
    global_session_epoch: epoch,
    source_company_membership_version: Number(
      row.source_company_membership_version,
    ),
    target_directory_membership_version: Number(
      row.target_directory_membership_version,
    ),
    company_membership_version: Number(row.company_membership_version),
    source_membership_version: Number(row.source_membership_version),
    tablet_pin_version:
      row.tablet_pin_version === null ? null : Number(row.tablet_pin_version),
  };
}

export async function listAccessibleBusinessCompanies(
  db: Db,
  profileId: string,
  environment: "cerp_prod" | "cerp_test",
) {
  return (
    await db.query(
      `SELECT c.company_id::text AS id,c.code,c.name,c.profile FROM public.cerp_business_companies c
 JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id AND m.profile_id=$1::uuid AND m.status='ACTIVE'
 JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id AND i.environment=$2 AND i.active
 JOIN public.cerp_directory_memberships dm ON dm.profile_id=m.profile_id AND dm.database_id=i.site_id AND dm.status='Active'
 WHERE c.status='ACTIVE' ORDER BY c.code`,
      [profileId, environment],
    )
  ).rows;
}

export async function lockSwitch(db: PoolClient, ticketHash: string) {
  return (
    (
      await db.query(
        `SELECT ticket_hash,request_key::text,source_session_hash,profile_id::text,source_site,target_site,company_id::text,environment,global_session_epoch,source_membership_version,company_membership_version,source_company_membership_version,target_directory_membership_version,expires_at,redeemed_at
 FROM public.cerp_business_company_switches WHERE ticket_hash=$1 FOR UPDATE`,
        [ticketHash],
      )
    ).rows[0] ?? null
  );
}

/** Bounded maintenance only; no ticket material is selected or logged. */
export async function expireBusinessCompanySwitches(db: Db, limit = 500) {
  const bounded = Math.max(1, Math.min(limit, 1000));
  return db.query(
    `DELETE FROM public.cerp_business_company_switches WHERE ticket_hash IN (
      SELECT ticket_hash FROM public.cerp_business_company_switches
      WHERE expires_at < now() ORDER BY expires_at LIMIT $1
    )`,
    [bounded],
  );
}
