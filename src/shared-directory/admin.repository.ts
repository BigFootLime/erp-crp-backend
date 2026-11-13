import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { directoryProfileSchema, siteIdSchema } from "./model";
import { ensureTestMembership } from "./session.repository";
import { HttpError } from "../utils/httpError";
import { avatarProjectionSql } from "../module/auth/repository/avatar.repository";
import { directoryWorkProfile } from "./work-profile";
/** A source UUID is the only cross-base identity key; local integer IDs stay local. */
export async function directoryProfileForSite(
  db: Pool,
  site: string,
  profileId: string,
) {
  siteIdSchema.parse(site);
  const source = (
    await db.query(
      "SELECT user_id FROM public.cerp_directory_profiles WHERE profile_id=$1::uuid",
      [profileId],
    )
  ).rows[0];
  if (!source)
    throw new HttpError(404, "USER_NOT_FOUND", "Utilisateur inconnu.");
  if (site !== "cerp_prod")
    await ensureTestMembership(db, site, source.user_id);
  const row = (
    await db.query(
      `SELECT p.profile_id,p.user_id AS source_user_id,$2::text AS database,u.username,u.name,u.surname,u.email,u.tel_no,u.avatar_key,${avatarProjectionSql} AS avatar_asset_id,
  coalesce(m.role_key,u.role) AS role,CASE WHEN cardinality(m.roles)>0 THEN m.roles ELSE ARRAY[coalesce(m.role_key,u.role)] END AS roles,coalesce(m.is_superadmin,false) AS is_superadmin,
  CASE WHEN m.profile_id IS NULL OR m.status<>'Active' OR EXISTS(SELECT 1 FROM public.cerp_directory_memberships prod WHERE prod.profile_id=p.profile_id AND prod.database_id='cerp_prod' AND prod.status<>'Active') THEN 'Inactive' ELSE u.status END AS status,p.job_title,p.employment_type,p.weekly_hours_target::float AS weekly_hours_target,p.work_profile_incomplete,u.mfa_reenrollment_required
  FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id
  LEFT JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id AND m.database_id=$2
  WHERE p.profile_id=$1::uuid`,
      [profileId, site],
    )
  ).rows[0];
  return directoryProfileSchema.parse({
    ...row,
    ...(await directoryWorkProfile(db, source.user_id)),
  });
}
/** Retry after a canonical creation commit completes its additive directory binding. */
export async function bindProvisionedProfile(
  db: Pool,
  userId: number,
  site: string,
  weeklyHours?: number,
) {
  const tx = await db.connect();
  await tx.query("BEGIN");
  try {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `directory-provisioned:${userId}`,
    ]);
    const result = await tx.query<{ profile_id: string }>(
      `INSERT INTO public.cerp_directory_profiles(profile_id,user_id,weekly_hours_target,work_profile_incomplete)
   VALUES($1::uuid,$2,$3,$4) ON CONFLICT(user_id) DO UPDATE SET user_id=excluded.user_id RETURNING profile_id`,
      [randomUUID(), userId, weeklyHours ?? null, weeklyHours == null],
    );
    const profile = result.rows[0].profile_id;
    await tx.query(
      "UPDATE public.users SET mfa_reenrollment_required=true WHERE id=$1 AND NOT mfa_reenrollment_required",
      [userId],
    );
    if (site === "cerp_test" || /^cerp_test_[a-f0-9]{32}$/.test(site))
      await tx.query(
        "UPDATE public.users SET mfa_required=true WHERE id=$1 AND NOT mfa_required",
        [userId],
      );
    await tx.query(
      `INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin)
   SELECT $1::uuid,$2,CASE WHEN $2='cerp_test' OR $2 ~ '^cerp_test_[a-f0-9]{32}$' THEN 'Administrateur Systeme et Reseau' ELSE role END,
    CASE WHEN $2='cerp_test' OR $2 ~ '^cerp_test_[a-f0-9]{32}$' THEN ARRAY['Administrateur Systeme et Reseau'] ELSE coalesce((SELECT array_agg(role_key ORDER BY role_key) FROM public.user_role_assignments WHERE user_id=$3),ARRAY[role]) END,
    'Active',($2='cerp_test' OR $2 ~ '^cerp_test_[a-f0-9]{32}$') FROM public.users WHERE id=$3
   ON CONFLICT(profile_id,database_id) DO NOTHING`,
      [profile, site, userId],
    );
    await tx.query("COMMIT");
    return profile;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
