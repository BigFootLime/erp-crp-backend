import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import jwt from "jsonwebtoken";
import { avatarProjectionSql } from "../module/auth/repository/avatar.repository";
import { directoryWorkProfile } from "./work-profile";
import {
  accountRequiresMfa,
  normalizeMfaPolicy,
} from "../module/auth/domain/mfa-policy";
import {
  directorySessionSchema,
  directoryIdSchema,
  siteIdSchema,
  type DirectorySession,
} from "./model";
type Queryable = Pick<Pool | PoolClient, "query">;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function assertDirectoryIdentity(
  db: Queryable,
  expectedId: string,
) {
  const id = directoryIdSchema.parse(expectedId);
  const actual = (
    await db.query(
      "SELECT current_database() AS database,current_user AS actor",
    )
  ).rows[0];
  if (actual?.database !== `cerp_directory_${id.replace(/-/g, "")}`)
    throw new Error("DIRECTORY_SOURCE_IDENTITY_MISMATCH");
  const meta = (
    await db.query(
      "SELECT directory_id,schema_version,import_mode FROM public.cerp_shared_directory WHERE singleton=true",
    )
  ).rows[0];
  if (
    meta?.directory_id !== id ||
    meta.schema_version !== 1 ||
    meta.import_mode !== "EMPTY_NO_LEGACY_IMPORT"
  )
    throw new Error("DIRECTORY_SOURCE_MARKER_INVALID");
}
export async function assertDirectoryApplicationRole(db: Queryable) {
  const role = (
    await db.query(`SELECT current_user AS actor,r.rolsuper,r.rolcreatedb,r.rolcreaterole,
  pg_has_role(r.oid,'cerp_app','MEMBER') AS business_member,
  has_database_privilege('cerp_app',current_database(),'CONNECT') AS business_connect,
  EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid) OR
  EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid) OR
  EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proowner=r.oid) AS owns_authority_objects
  FROM pg_roles r WHERE r.rolname=current_user`)
  ).rows[0];
  if (
    role?.actor !== "cerp_directory_app" ||
    role.rolsuper ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.business_member ||
    role.business_connect ||
    role.owns_authority_objects
  )
    throw new Error("DIRECTORY_SOURCE_DATABASE_ROLE_INVALID");
}
export async function consumeCallNonce(
  db: Queryable,
  nonce: string,
  expires: Date,
) {
  directoryIdSchema.parse(nonce);
  const inserted = await db.query(
    "INSERT INTO public.cerp_directory_call_nonces(nonce,expires_at) VALUES($1::uuid,$2) ON CONFLICT DO NOTHING RETURNING nonce",
    [nonce, expires],
  );
  if (inserted.rows.length !== 1) throw new Error("DIRECTORY_CALL_REPLAYED");
  await db.query(
    "DELETE FROM public.cerp_directory_call_nonces WHERE nonce IN (SELECT nonce FROM public.cerp_directory_call_nonces WHERE expires_at<now() LIMIT 1000)",
  );
}
export async function bindChallenge(
  db: Queryable,
  site: string,
  challenge: string,
  expiresSeconds = 900,
  tabletDeviceId?: string,
  tabletPinVersion?: number,
  tabletPinProfileId?: string,
) {
  siteIdSchema.parse(site);
  await db.query(
    "INSERT INTO public.cerp_directory_challenges(token_hash,database_id,expires_at,tablet_device_id,tablet_pin_version,tablet_pin_profile_id) VALUES($1,$2,now()+$3::int*interval'1 second',$4::uuid,$5,$6::uuid) ON CONFLICT DO NOTHING",
    [
      hash(challenge),
      site,
      expiresSeconds,
      tabletDeviceId ?? null,
      tabletPinVersion ?? null,
      tabletPinProfileId ?? null,
    ],
  );
}
export async function assertChallengeSite(
  db: Queryable,
  site: string,
  challenge: string,
) {
  siteIdSchema.parse(site);
  const row = (
    await db.query<{
      tablet_device_id: string | null;
      tablet_pin_version: number | null;
      tablet_pin_profile_id: string | null;
    }>(
      `SELECT c.tablet_device_id,c.tablet_pin_version,c.tablet_pin_profile_id FROM public.cerp_directory_challenges c LEFT JOIN public.cerp_directory_tablet_devices d ON d.device_id=c.tablet_device_id LEFT JOIN public.cerp_directory_tablet_pins p ON p.profile_id=c.tablet_pin_profile_id AND p.version=c.tablet_pin_version WHERE c.token_hash=$1 AND c.database_id=$2 AND c.expires_at>now() AND (c.tablet_device_id IS NULL OR (d.revoked_at IS NULL AND d.device_secret_hash IS NOT NULL AND p.profile_id IS NOT NULL))`,
      [hash(challenge), site],
    )
  ).rows[0];
  if (!row) throw new Error("DIRECTORY_CHALLENGE_REJECTED");
  return row;
}
export async function ensureTestMembership(
  db: Queryable,
  site: string,
  sourceUserId: number,
) {
  siteIdSchema.parse(site);
  if (site === "cerp_prod" || site.startsWith("cerp_company_")) return;
  const registry = await db.query(
    `SELECT to_regclass('public.cerp_business_company_instances') AS registry`,
  );
  if (registry.rows[0]?.registry) {
    const registered = await db.query(
      `SELECT EXISTS(SELECT 1 FROM public.cerp_business_company_instances WHERE site_id=$1) AS registered`,
      [site],
    );
    if (registered.rows[0]?.registered) return;
  }
  await db.query(
    `INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin)
  SELECT p.profile_id,$1,m.role_key,m.roles,'Active',m.is_superadmin
  FROM public.cerp_directory_profiles p
  JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id='cerp_prod' AND m.status='Active'
  JOIN public.users u ON u.id=p.user_id AND u.status='Active'
  WHERE p.user_id=$2
  ON CONFLICT(profile_id,database_id) DO UPDATE SET role_key=excluded.role_key,roles=excluded.roles,
   is_superadmin=excluded.is_superadmin,version=public.cerp_directory_memberships.version+1
  WHERE public.cerp_directory_memberships.status='Active'
   AND (public.cerp_directory_memberships.role_key,public.cerp_directory_memberships.roles,public.cerp_directory_memberships.is_superadmin)
     IS DISTINCT FROM (excluded.role_key,excluded.roles,excluded.is_superadmin)`,
    [site, sourceUserId],
  );
}
export async function hasActiveMembership(
  db: Queryable,
  site: string,
  username: string,
) {
  const result = await db.query(
    `SELECT u.id FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id
  JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id=$1
  WHERE upper(u.username)=upper($2) AND u.status='Active' AND m.status='Active'
  AND NOT EXISTS(SELECT 1 FROM public.cerp_directory_memberships prod WHERE prod.profile_id=p.profile_id AND prod.database_id='cerp_prod' AND prod.status<>'Active')`,
    [site, username],
  );
  return result.rows[0]?.id as number | undefined;
}
export async function createDirectorySession(
  db: Queryable,
  site: string,
  canonicalToken: string,
  sourceJwtSecret: string,
  tabletDeviceId?: string,
  tabletPinVersion?: number,
) {
  siteIdSchema.parse(site);
  const claims = jwt.verify(canonicalToken, sourceJwtSecret, {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload;
  if (
    !Number.isSafeInteger(claims.id) ||
    claims.id <= 0 ||
    !Number.isSafeInteger(claims.session_epoch) ||
    claims.session_epoch < 0
  )
    throw new Error("DIRECTORY_SESSION_REJECTED");
  const hasMfa = claims.mfa === true;
  const method =
    hasMfa && claims.amr?.includes("recovery_code")
      ? "recovery_code"
      : hasMfa && claims.amr?.includes("totp")
        ? "totp"
        : null;
  if (hasMfa) {
    directoryIdSchema.parse(claims.mfa_factor_id);
    if (
      !method ||
      !Number.isSafeInteger(claims.mfa_factor_version) ||
      claims.mfa_factor_version <= 0 ||
      !Number.isSafeInteger(claims.mfa_verified_at) ||
      claims.mfa_verified_at <= 0 ||
      claims.mfa_verified_at > Date.now() / 1000 + 5
    )
      throw new Error("DIRECTORY_MFA_REQUIRED");
  } else if (
    ["mfa", "mfa_factor_id", "mfa_factor_version", "mfa_verified_at"].some(
      (key) => claims[key] !== undefined,
    )
  )
    throw new Error("DIRECTORY_MFA_REQUIRED");
  const token = `dir_${randomBytes(32).toString("hex")}`;
  const inserted = await db.query(
    `INSERT INTO public.cerp_directory_sessions(token_hash,profile_id,database_id,global_session_epoch,membership_version,mfa_factor_id,mfa_factor_version,mfa_verified_at,mfa_method,expires_at,tablet_device_id,tablet_pin_version)
  SELECT $1,p.profile_id,$2,$3,m.version,$4::uuid,$5,to_timestamp($6::double precision),$8,now()+interval '1 day',$10::uuid,$11
  FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id
  JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id=$2
  LEFT JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.id=$4::uuid AND f.version=$5 AND f.state='ACTIVE'
  LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id
  WHERE u.id=$7 AND u.status='Active' AND m.status='Active' AND NOT u.mfa_reenrollment_required AND coalesce(e.session_epoch,0)=$3
  AND NOT EXISTS(SELECT 1 FROM public.cerp_directory_memberships prod WHERE prod.profile_id=p.profile_id AND prod.database_id='cerp_prod' AND prod.status<>'Active')
  AND (($9::boolean AND f.id IS NOT NULL) OR (NOT $9::boolean AND NOT u.mfa_required AND NOT u.is_superadmin AND NOT m.is_superadmin
    AND NOT EXISTS(SELECT 1 FROM public.user_mfa_factors active_factor WHERE active_factor.user_id=u.id AND active_factor.state='ACTIVE')))
  AND ($10::uuid IS NULL OR EXISTS(SELECT 1 FROM public.cerp_directory_tablet_devices td2 JOIN public.cerp_directory_tablet_pins pin ON pin.profile_id=p.profile_id WHERE td2.device_id=$10::uuid AND td2.revoked_at IS NULL AND td2.device_secret_hash IS NOT NULL AND pin.pin_hash IS NOT NULL AND pin.version=$11))
  RETURNING token_hash`,
    [
      hash(token),
      site,
      claims.session_epoch,
      hasMfa ? claims.mfa_factor_id : null,
      hasMfa ? claims.mfa_factor_version : null,
      hasMfa ? claims.mfa_verified_at : null,
      claims.id,
      method,
      hasMfa,
      tabletDeviceId ?? null,
      tabletPinVersion ?? null,
    ],
  );
  if (inserted.rows.length !== 1) throw new Error("DIRECTORY_SESSION_REJECTED");
  return {
    directory_session: token,
    identity: await validateDirectorySession(db, site, token),
  };
}

/**
 * Creates a session in another Directory site only from an already validated
 * Directory identity. It never accepts a browser supplied profile, password,
 * site membership, or source bearer token.
 */
export async function createDirectorySessionFromIdentity(
  db: Queryable,
  targetSite: string,
  source: DirectorySession,
  options: { token?: string; expiresAt?: Date } = {},
) {
  siteIdSchema.parse(targetSite);
  const token = options.token ?? `dir_${randomBytes(32).toString("hex")}`;
  if (!/^dir_[a-f0-9]{64}$/.test(token))
    throw new Error("DIRECTORY_SESSION_REJECTED");
  const expiresAt =
    options.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  const inserted = await db.query(
    `INSERT INTO public.cerp_directory_sessions(
 token_hash,profile_id,database_id,global_session_epoch,membership_version,
 mfa_factor_id,mfa_factor_version,mfa_verified_at,mfa_method,expires_at,tablet_device_id,tablet_pin_version)
 SELECT $1,p.profile_id,$2,$3,m.version,$4::uuid,$5,to_timestamp($6::double precision),$7,$11::timestamptz,$12::uuid,$13
 FROM public.cerp_directory_profiles p
 JOIN public.users u ON u.id=p.user_id
 JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id=$2
 LEFT JOIN public.user_mfa_factors f ON f.user_id=u.id AND f.id=$4::uuid AND f.version=$5 AND f.state='ACTIVE'
 LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id
 WHERE p.profile_id=$8::uuid AND p.user_id=$9 AND u.status='Active' AND m.status='Active'
 AND coalesce(e.session_epoch,0)=$3 AND NOT u.mfa_reenrollment_required
 AND NOT EXISTS(SELECT 1 FROM public.cerp_directory_memberships prod WHERE prod.profile_id=p.profile_id AND prod.database_id='cerp_prod' AND prod.status<>'Active')
 AND (($10::boolean AND f.id IS NOT NULL) OR (NOT $10::boolean AND NOT u.mfa_required AND NOT u.is_superadmin AND NOT m.is_superadmin
 AND NOT EXISTS(SELECT 1 FROM public.user_mfa_factors active_factor WHERE active_factor.user_id=u.id AND active_factor.state='ACTIVE')))
 AND ($12::uuid IS NULL OR EXISTS(SELECT 1 FROM public.cerp_directory_tablet_devices td JOIN public.cerp_directory_tablet_pins pin ON pin.profile_id=p.profile_id AND pin.version=$13 WHERE td.device_id=$12::uuid AND td.revoked_at IS NULL AND td.device_secret_hash IS NOT NULL AND pin.pin_hash IS NOT NULL))
 ON CONFLICT(token_hash) DO NOTHING
 RETURNING token_hash`,
    [
      hash(token),
      targetSite,
      source.global_session_epoch,
      source.mfa_factor_id,
      source.mfa_factor_version,
      source.mfa_verified_at
        ? Math.floor(Date.parse(source.mfa_verified_at) / 1000)
        : null,
      source.mfa_method,
      source.profile_id,
      source.source_user_id,
      source.mfa_factor_id !== null,
      expiresAt.toISOString(),
      source.tablet_device_id ?? null,
      source.tablet_pin_version ?? null,
    ],
  );
  // A deterministic switch token can be retried after an ambiguous network
  // failure. Its hash is unique and the existing row is revalidated below.
  if (inserted.rows.length !== 1) {
    const existing = await db.query(
      "SELECT 1 FROM public.cerp_directory_sessions WHERE token_hash=$1 AND database_id=$2",
      [hash(token), targetSite],
    );
    if (existing.rows.length !== 1)
      throw new Error("DIRECTORY_SESSION_REJECTED");
  }
  return {
    directory_session: token,
    identity: await validateDirectorySession(db, targetSite, token, {
      autoProvisionTestMembership: false,
    }),
  };
}
export async function validateDirectorySession(
  db: Queryable,
  site: string,
  token: string,
  options: { autoProvisionTestMembership?: boolean } = {},
): Promise<DirectorySession> {
  siteIdSchema.parse(site);
  if (!/^dir_[a-f0-9]{64}$/.test(token))
    throw new Error("DIRECTORY_SESSION_REJECTED");
  if (site !== "cerp_prod" && options.autoProvisionTestMembership !== false) {
    const source = (
      await db.query<{ user_id: number }>(
        `SELECT p.user_id FROM public.cerp_directory_sessions s JOIN public.cerp_directory_profiles p ON p.profile_id=s.profile_id
   WHERE s.token_hash=$1 AND s.database_id=$2 AND s.expires_at>now()`,
        [hash(token), site],
      )
    ).rows[0];
    if (source && Number.isSafeInteger(source.user_id))
      await ensureTestMembership(db, site, source.user_id);
  }
  const row = (
    await db.query(
      `SELECT p.profile_id,u.id AS source_user_id,s.database_id AS database,u.username,u.name,u.surname,u.email,u.tel_no,u.avatar_key,${avatarProjectionSql} AS avatar_asset_id,
  m.role_key AS role,CASE WHEN cardinality(m.roles)>0 THEN m.roles ELSE ARRAY[m.role_key] END AS roles,m.is_superadmin,u.status,p.job_title,p.employment_type,p.weekly_hours_target::float AS weekly_hours_target,p.work_profile_incomplete,u.mfa_reenrollment_required,s.global_session_epoch,m.version AS membership_version,
  s.mfa_factor_id,s.mfa_factor_version,s.mfa_verified_at,s.mfa_method,s.tablet_device_id,s.tablet_pin_version,
  u.is_superadmin AS canonical_is_superadmin,u.mfa_required AS durable_mfa_required,u.role AS canonical_role,
  coalesce((SELECT array_agg(ura.role_key) FROM public.user_role_assignments ura WHERE ura.user_id=u.id),ARRAY[u.role]) AS canonical_roles,
  (SELECT value_text FROM public.erp_settings WHERE key='security.mfa_policy') AS mfa_policy,
  EXISTS(SELECT 1 FROM public.user_mfa_factors active_factor WHERE active_factor.user_id=u.id AND active_factor.state='ACTIVE') AS has_active_factor
  FROM public.cerp_directory_sessions s JOIN public.cerp_directory_profiles p ON p.profile_id=s.profile_id JOIN public.users u ON u.id=p.user_id
  JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id=s.database_id
  LEFT JOIN public.user_mfa_factors f ON f.id=s.mfa_factor_id AND f.user_id=u.id
  LEFT JOIN public.realtime_session_epochs e ON e.user_id=u.id LEFT JOIN public.cerp_directory_tablet_devices td ON td.device_id=s.tablet_device_id LEFT JOIN public.cerp_directory_tablet_pins pin ON pin.profile_id=s.profile_id AND pin.version=s.tablet_pin_version
  WHERE s.token_hash=$1 AND s.database_id=$2 AND s.expires_at>now() AND u.status='Active' AND NOT u.mfa_reenrollment_required AND m.status='Active'
  AND NOT EXISTS(SELECT 1 FROM public.cerp_directory_memberships prod WHERE prod.profile_id=p.profile_id AND prod.database_id='cerp_prod' AND prod.status<>'Active')
  AND m.version=s.membership_version AND coalesce(e.session_epoch,0)=s.global_session_epoch AND (s.tablet_device_id IS NULL OR (td.revoked_at IS NULL AND td.device_secret_hash IS NOT NULL AND pin.profile_id IS NOT NULL AND pin.pin_hash IS NOT NULL))
  AND ((s.mfa_factor_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.user_mfa_factors active_factor WHERE active_factor.user_id=u.id AND active_factor.state='ACTIVE'))
    OR (s.mfa_factor_id IS NOT NULL AND f.state='ACTIVE' AND f.version=s.mfa_factor_version))`,
      [hash(token), site],
    )
  ).rows[0];
  if (!row) throw new Error("DIRECTORY_SESSION_REJECTED");
  const {
    canonical_is_superadmin,
    durable_mfa_required,
    canonical_role,
    canonical_roles,
    mfa_policy,
    has_active_factor,
    tablet_device_id,
    tablet_pin_version,
    ...profile
  } = row;
  if (
    row.mfa_factor_id === null &&
    accountRequiresMfa({
      policy: normalizeMfaPolicy(mfa_policy),
      isSuperadmin: canonical_is_superadmin || row.is_superadmin,
      role: canonical_role,
      roles: canonical_roles,
      hasActiveFactor: has_active_factor,
      mfaRequired: durable_mfa_required,
    })
  )
    throw new Error("DIRECTORY_SESSION_REJECTED");
  return directorySessionSchema.parse({
    ...profile,
    ...(await directoryWorkProfile(db, row.source_user_id)),
    global_session_epoch: Number(row.global_session_epoch),
    mfa_verified_at:
      row.mfa_verified_at === null
        ? null
        : new Date(row.mfa_verified_at).toISOString(),
    ...(tablet_device_id === null
      ? {}
      : { tablet_device_id, tablet_pin_version }),
  });
}
