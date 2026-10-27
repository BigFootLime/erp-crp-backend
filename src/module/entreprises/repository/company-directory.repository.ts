import type { Pool, PoolClient } from "pg";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import type {
  BusinessCompanyInput,
  CompanySiteAdministrativeLevel,
  CompanySiteAdministrativeLevelInput,
  CompanyContextRecord,
  CompanyInstanceInput,
  DirectoryAuditActor,
  MembershipInput,
} from "./company-directory.types";
import type { DirectorySession } from "../../../shared-directory/model";
import { requireDirectoryAdmin } from "../../../shared-directory/authority";
import { HttpError } from "../../../utils/httpError";

type CompanyRow = {
  company_id: string;
  code: string;
  name: string;
  profile: string;
  status: string;
  enabled_module_keys: string[];
  enabled_commercial_projection_capabilities: string[];
  version: number;
};
const audit = (
  tx: PoolClient,
  actor: DirectoryAuditActor,
  action: string,
  entity_type: string,
  entity_id: string,
  details: Record<string, unknown>,
) =>
  repoInsertAuditLog({
    tx,
    user_id: actor.user_id,
    ip: actor.ip,
    user_agent: actor.user_agent,
    device_type: actor.device_type,
    os: actor.os,
    browser: actor.browser,
    body: {
      event_type: "ACTION",
      action,
      entity_type,
      entity_id,
      path: "/internal/directory/business-companies",
      details,
    },
  });

export async function repoListBusinessCompanies(db: Pool) {
  return (
    await db.query(
      `SELECT company_id::text AS company_id,code,name,profile,status,enabled_module_keys,enabled_commercial_projection_capabilities,version FROM public.cerp_business_companies ORDER BY code`,
    )
  ).rows;
}
/** One statement keeps optimistic versions and grants on the same snapshot. */
export async function repoReadBusinessCompanyAdministration(
  db: Pool,
  companyId: string,
) {
  const row = (
    await db.query(
      `SELECT c.company_id::text,c.code,c.name,c.profile,c.status,c.enabled_module_keys,c.enabled_commercial_projection_capabilities,c.version,
    coalesce((SELECT jsonb_agg(jsonb_build_object('profile_id',m.profile_id::text,'username',u.username,'name',u.name,'surname',u.surname,'status',m.status,'allowed_module_keys',m.allowed_module_keys,'denied_module_keys',m.denied_module_keys,'enabled_commercial_projection_capabilities',m.enabled_commercial_projection_capabilities,'version',m.version) ORDER BY u.username,p.profile_id)
      FROM public.cerp_business_company_memberships m JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id WHERE m.company_id=c.company_id),'[]'::jsonb) AS memberships,
    coalesce((SELECT jsonb_agg(jsonb_build_object('environment',i.environment,'site_id',i.site_id,'active',i.active,'version',i.version) ORDER BY i.environment) FROM public.cerp_business_company_instances i WHERE i.company_id=c.company_id),'[]'::jsonb) AS instances
    FROM public.cerp_business_companies c WHERE c.company_id=$1::uuid`,
      [companyId],
    )
  ).rows[0];
  if (!row) throw new Error("BUSINESS_COMPANY_NOT_FOUND");
  return row;
}

/** Identity selection is explicit; names never grant company membership. */
export async function repoSearchBusinessCompanyProfiles(
  db: Pool,
  search: string,
) {
  return (
    await db.query(
      `SELECT p.profile_id::text,u.username,u.name,u.surname,u.status FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id
    WHERE $1='' OR strpos(lower(concat_ws(' ',u.username,u.name,u.surname)),lower($1))>0 ORDER BY u.username,p.profile_id LIMIT 100`,
      [search],
    )
  ).rows;
}
export async function repoListBusinessCompaniesForProfile(
  db: Pool,
  profileId: string,
  environment: "cerp_prod" | "cerp_test",
) {
  return (
    await db.query(
      `SELECT c.company_id::text AS company_id,c.code,c.name,c.profile,c.status,c.version,i.site_id,i.active,i.version AS instance_version,m.status AS membership_status,m.version AS membership_version FROM public.cerp_business_companies c JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id WHERE m.profile_id=$1::uuid AND i.environment=$2 ORDER BY c.code`,
      [profileId, environment],
    )
  ).rows;
}
export async function repoReadBusinessCompanyInstanceBySite(
  db: Pool,
  siteId: string,
) {
  return (
    (
      await db.query(
        `SELECT i.company_id::text AS company_id,i.environment,i.site_id,i.active,i.version,c.code,c.status AS company_status FROM public.cerp_business_company_instances i JOIN public.cerp_business_companies c ON c.company_id=i.company_id WHERE i.site_id=$1`,
        [siteId],
      )
    ).rows[0] ?? null
  );
}

export async function repoCreateBusinessCompany(
  db: Pool,
  input: BusinessCompanyInput,
  actor: DirectoryAuditActor,
) {
  return withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
    const row = (
      await tx.query<CompanyRow>(
        `INSERT INTO public.cerp_business_companies(company_id,code,name,profile,status,enabled_module_keys,enabled_commercial_projection_capabilities,created_by_user_id,updated_by_user_id)
      VALUES($1::uuid,$2,$3,$4,$5,$6::text[],$7::text[],$8,$8) RETURNING company_id::text AS company_id,code,name,profile,status,enabled_module_keys,enabled_commercial_projection_capabilities,version`,
        [
          input.company_id,
          input.code,
          input.name,
          input.profile,
          input.status,
          input.enabled_module_keys,
          input.enabled_commercial_projection_capabilities,
          actor.user_id,
        ],
      )
    ).rows[0];
    await audit(
      tx,
      actor,
      "BUSINESS_COMPANY_CREATED",
      "business_company",
      row.company_id,
      { code: row.code, profile: row.profile, status: row.status },
    );
    return row;
  });
}

export async function repoUpdateBusinessCompany(
  db: Pool,
  input: BusinessCompanyInput & { expected_version: number },
  actor: DirectoryAuditActor,
) {
  return withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
    const locked = (
      await tx.query<{ version: number }>(
        `SELECT version FROM public.cerp_business_companies WHERE company_id=$1::uuid FOR UPDATE`,
        [input.company_id],
      )
    ).rows[0];
    if (!locked) throw new Error("BUSINESS_COMPANY_NOT_FOUND");
    if (locked.version !== input.expected_version)
      throw new Error("BUSINESS_COMPANY_VERSION_CONFLICT");
    const row = (
      await tx.query<CompanyRow>(
        `UPDATE public.cerp_business_companies SET code=$2,name=$3,profile=$4,status=$5,enabled_module_keys=$6::text[],enabled_commercial_projection_capabilities=$7::text[],version=version+1,updated_by_user_id=$8,updated_at=now() WHERE company_id=$1::uuid RETURNING company_id::text AS company_id,code,name,profile,status,enabled_module_keys,enabled_commercial_projection_capabilities,version`,
        [
          input.company_id,
          input.code,
          input.name,
          input.profile,
          input.status,
          input.enabled_module_keys,
          input.enabled_commercial_projection_capabilities,
          actor.user_id,
        ],
      )
    ).rows[0];
    if (row.status !== "ACTIVE") {
      await tx.query(
        `UPDATE public.cerp_directory_memberships dm SET status='Inactive',version=version+1
         FROM public.cerp_business_company_instances i
         WHERE i.company_id=$1::uuid AND dm.database_id=i.site_id
           AND i.site_id ~ '^cerp_company_[a-f0-9]{32}_(prod|test)$' AND dm.status<>'Inactive'`,
        [input.company_id],
      );
    }
    await audit(
      tx,
      actor,
      "BUSINESS_COMPANY_UPDATED",
      "business_company",
      row.company_id,
      { version: row.version },
    );
    return row;
  });
}

export async function repoSetBusinessCompanyMembership(
  db: Pool,
  input: MembershipInput,
  actor: DirectoryAuditActor,
) {
  return withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `business-company-membership:${input.company_id}:${input.profile_id}`,
    ]);
    const current = (
      await tx.query<{ version: number }>(
        `SELECT version FROM public.cerp_business_company_memberships WHERE company_id=$1::uuid AND profile_id=$2::uuid FOR UPDATE`,
        [input.company_id, input.profile_id],
      )
    ).rows[0];
    if ((current?.version ?? 0) !== input.expected_version)
      throw new Error("BUSINESS_COMPANY_MEMBERSHIP_VERSION_CONFLICT");
    const row = (
      await tx.query(
        `INSERT INTO public.cerp_business_company_memberships(company_id,profile_id,status,allowed_module_keys,denied_module_keys,enabled_commercial_projection_capabilities,created_by_user_id,updated_by_user_id)
      VALUES($1::uuid,$2::uuid,$3,$4::text[],$5::text[],$6::text[],$7,$7) ON CONFLICT(company_id,profile_id) DO UPDATE SET status=excluded.status,allowed_module_keys=excluded.allowed_module_keys,denied_module_keys=excluded.denied_module_keys,enabled_commercial_projection_capabilities=excluded.enabled_commercial_projection_capabilities,version=public.cerp_business_company_memberships.version+1,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()
      RETURNING company_id::text,profile_id::text,status,allowed_module_keys,denied_module_keys,enabled_commercial_projection_capabilities,version`,
        [
          input.company_id,
          input.profile_id,
          input.status,
          input.allowed_module_keys,
          input.denied_module_keys,
          input.enabled_commercial_projection_capabilities,
          actor.user_id,
        ],
      )
    ).rows[0];
    // A business membership is useful only when the Directory can issue a
    // session for the registered company instances.  This is deliberately
    // scoped to `cerp_company_*`: it must never rewrite the CRP Prod/Test
    // memberships that pre-date the company registry.
    await tx.query(
      `INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin)
       SELECT p.profile_id,i.site_id,u.role,
         coalesce((SELECT array_agg(ra.role_key ORDER BY ra.role_key) FROM public.user_role_assignments ra WHERE ra.user_id=u.id),ARRAY[u.role]::text[]),
         CASE WHEN $3='ACTIVE' AND c.status='ACTIVE' AND i.active THEN 'Active' ELSE 'Inactive' END,false
       FROM public.cerp_directory_profiles p
       JOIN public.users u ON u.id=p.user_id
       JOIN public.cerp_business_companies c ON c.company_id=$1::uuid
       JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id
       WHERE p.profile_id=$2::uuid AND i.site_id ~ '^cerp_company_[a-f0-9]{32}_(prod|test)$'
       ON CONFLICT(profile_id,database_id) DO UPDATE SET
         role_key=excluded.role_key,roles=excluded.roles,status=excluded.status,
         version=public.cerp_directory_memberships.version+1`,
      [input.company_id, input.profile_id, input.status],
    );
    await audit(
      tx,
      actor,
      "BUSINESS_COMPANY_MEMBERSHIP_SET",
      "business_company_membership",
      `${row.company_id}:${row.profile_id}`,
      { status: row.status, version: row.version },
    );
    return row;
  });
}
export async function repoSetBusinessCompanyInstance(
  db: Pool,
  input: CompanyInstanceInput,
  actor: DirectoryAuditActor,
) {
  return withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `business-company-instance:${input.company_id}:${input.environment}`,
    ]);
    const existing = (
      await tx.query<{ version: number }>(
        `SELECT version FROM public.cerp_business_company_instances WHERE company_id=$1::uuid AND environment=$2 FOR UPDATE`,
        [input.company_id, input.environment],
      )
    ).rows[0];
    // Instances may be created after memberships. Provision every explicit
    // ACTIVE company member, never by a role/name match.
    await tx.query(
      `INSERT INTO public.cerp_directory_memberships(profile_id,database_id,role_key,roles,status,is_superadmin)
       SELECT p.profile_id,$3,u.role,
         coalesce((SELECT array_agg(ra.role_key ORDER BY ra.role_key) FROM public.user_role_assignments ra WHERE ra.user_id=u.id),ARRAY[u.role]::text[]),
         CASE WHEN m.status='ACTIVE' AND c.status='ACTIVE' AND $4 THEN 'Active' ELSE 'Inactive' END,false
       FROM public.cerp_business_company_memberships m
       JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id
       JOIN public.users u ON u.id=p.user_id
       JOIN public.cerp_business_companies c ON c.company_id=m.company_id
       WHERE m.company_id=$1::uuid AND $3 ~ '^cerp_company_[a-f0-9]{32}_(prod|test)$'
       ON CONFLICT(profile_id,database_id) DO UPDATE SET role_key=excluded.role_key,roles=excluded.roles,status=excluded.status,
         version=public.cerp_directory_memberships.version+1`,
      [input.company_id, input.environment, input.site_id, input.active],
    );
    if ((existing?.version ?? 0) !== input.expected_version)
      throw new Error("BUSINESS_COMPANY_INSTANCE_VERSION_CONFLICT");
    const row = (
      await tx.query(
        `INSERT INTO public.cerp_business_company_instances(company_id,environment,site_id,active,created_by_user_id,updated_by_user_id) VALUES($1::uuid,$2,$3,$4,$5,$5) ON CONFLICT(company_id,environment) DO UPDATE SET site_id=excluded.site_id,active=excluded.active,version=public.cerp_business_company_instances.version+1,updated_by_user_id=excluded.updated_by_user_id,updated_at=now() RETURNING company_id::text,environment,site_id,active,version`,
        [
          input.company_id,
          input.environment,
          input.site_id,
          input.active,
          actor.user_id,
        ],
      )
    ).rows[0];
    await audit(
      tx,
      actor,
      "BUSINESS_COMPANY_INSTANCE_SET",
      "business_company_instance",
      `${row.company_id}:${row.environment}`,
      { site_id: row.site_id, active: row.active, version: row.version },
    );
    return row;
  });
}

function companyInstanceSiteId(
  companyId: string,
  environment: "cerp_prod" | "cerp_test",
) {
  return `cerp_company_${companyId.replace(/-/g, "")}_${
    environment === "cerp_prod" ? "prod" : "test"
  }`;
}
type CompanySiteAdministrativeLevelRow = CompanySiteAdministrativeLevel & {
  company_status: string;
  instance_active: boolean;
  company_membership_status: string;
  user_status: string;
  mfa_reenrollment_required: boolean;
  active_mfa_factor: boolean;
};
async function companySiteAdministrativeLevel(
  db: Pool | PoolClient,
  input: Pick<CompanySiteAdministrativeLevelInput, "company_id" | "profile_id" | "environment">,
  lock = false,
) {
  const siteId = companyInstanceSiteId(input.company_id, input.environment);
  const row = (
    await db.query<CompanySiteAdministrativeLevelRow>(
      `SELECT c.company_id::text AS company_id,m.profile_id::text AS profile_id,i.environment,i.site_id,
        dm.is_superadmin,dm.status,dm.version,c.status AS company_status,i.active AS instance_active,
        m.status AS company_membership_status,u.status AS user_status,u.mfa_reenrollment_required,
        EXISTS(SELECT 1 FROM public.user_mfa_factors f WHERE f.user_id=u.id AND f.state='ACTIVE') AS active_mfa_factor
       FROM public.cerp_business_companies c
       JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id
       JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id
       JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id
       JOIN public.users u ON u.id=p.user_id
       JOIN public.cerp_directory_memberships dm ON dm.profile_id=m.profile_id AND dm.database_id=i.site_id
       WHERE c.company_id=$1::uuid AND m.profile_id=$2::uuid AND i.environment=$3 AND i.site_id=$4
       ${lock ? "FOR UPDATE OF c,i,m,dm,u" : ""}`,
      [input.company_id, input.profile_id, input.environment, siteId],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(404, "BUSINESS_COMPANY_SITE_MEMBERSHIP_NOT_FOUND", "Cette identité n'a pas d'accès explicite à cette entreprise.");
  if (row.company_status !== "ACTIVE" || !row.instance_active || row.company_membership_status !== "ACTIVE" || row.status !== "Active")
    throw new HttpError(409, "BUSINESS_COMPANY_SITE_MEMBERSHIP_INACTIVE", "L'entreprise, son instance ou l'accès de ce compte n'est pas actif.");
  return row;
}
function administrativeLevelResult(row: CompanySiteAdministrativeLevelRow): CompanySiteAdministrativeLevel {
  return { company_id: row.company_id, profile_id: row.profile_id, environment: row.environment, site_id: row.site_id, is_superadmin: row.is_superadmin, status: row.status, version: row.version };
}
/** The site is derived from the company UUID/environment: CRP global sites cannot match. */
export async function repoReadBusinessCompanySiteAdministrativeLevel(
  db: Pool,
  input: Pick<CompanySiteAdministrativeLevelInput, "company_id" | "profile_id" | "environment">,
) {
  return administrativeLevelResult(await companySiteAdministrativeLevel(db, input));
}
/** Mutates only an existing explicit tenant membership and revokes prior sessions by version. */
export async function repoSetBusinessCompanySiteAdministrativeLevel(
  db: Pool,
  actor: DirectorySession,
  input: CompanySiteAdministrativeLevelInput,
) {
  requireDirectoryAdmin(actor);
  return withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`business-company-site-superadmin:${input.company_id}:${input.environment}:${input.profile_id}`]);
    requireDirectoryAdmin(actor);
    const current = await companySiteAdministrativeLevel(tx, input, true);
    if (current.version !== input.expected_version)
      throw new HttpError(409, "BUSINESS_COMPANY_SITE_MEMBERSHIP_STALE", "Les droits de ce compte viennent de changer ; actualisez avant de réessayer.");
    if (current.is_superadmin === input.is_superadmin) return administrativeLevelResult(current);
    if (input.is_superadmin && (current.user_status !== "Active" || current.mfa_reenrollment_required || !current.active_mfa_factor))
      throw new HttpError(409, "BUSINESS_COMPANY_SITE_TARGET_MFA_REQUIRED", "Le compte cible doit être actif et disposer d'un facteur MFA actif.");
    const updated = (
      await tx.query<CompanySiteAdministrativeLevel>(
        `UPDATE public.cerp_directory_memberships SET is_superadmin=$5,version=version+1
         WHERE profile_id=$1::uuid AND database_id=$2 AND version=$3
         RETURNING $4::uuid::text AS company_id,profile_id::text AS profile_id,$6::text AS environment,database_id AS site_id,is_superadmin,status,version`,
        [input.profile_id, current.site_id, input.expected_version, input.company_id, input.is_superadmin, input.environment],
      )
    ).rows[0];
    if (!updated)
      throw new HttpError(409, "BUSINESS_COMPANY_SITE_MEMBERSHIP_STALE", "Les droits de ce compte viennent de changer ; actualisez avant de réessayer.");
    await audit(tx, { user_id: actor.source_user_id, ip: null, user_agent: null, device_type: null, os: null, browser: null }, "BUSINESS_COMPANY_SITE_SUPERADMIN_CHANGED", "directory_membership", `${updated.company_id}:${updated.environment}:${updated.profile_id}`, { site_id: updated.site_id, previous_is_superadmin: current.is_superadmin, next_is_superadmin: updated.is_superadmin, membership_version: updated.version });
    return updated;
  });
}

export async function repoReadBusinessCompanyContext(
  db: Pool,
  params: {
    company_id: string;
    profile_id: string;
    environment: "cerp_prod" | "cerp_test";
  },
): Promise<CompanyContextRecord | null> {
  const row = (
    await db.query<CompanyContextRecord>(
      `SELECT c.company_id::text,c.code,c.name,c.profile,c.status AS company_status,c.enabled_module_keys,c.enabled_commercial_projection_capabilities AS company_projection_capabilities,m.status AS membership_status,m.allowed_module_keys,m.denied_module_keys,m.enabled_commercial_projection_capabilities AS membership_projection_capabilities,m.profile_id::text,p.user_id::int AS central_account_id,i.environment,i.site_id,i.active AS instance_active
 FROM public.cerp_business_companies c JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id JOIN public.cerp_business_company_instances i ON i.company_id=c.company_id JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id
 WHERE c.company_id=$1::uuid AND m.profile_id=$2::uuid AND i.environment=$3 LIMIT 1`,
      [params.company_id, params.profile_id, params.environment],
    )
  ).rows[0];
  return row ?? null;
}
