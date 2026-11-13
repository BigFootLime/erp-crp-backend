import type { Pool, PoolClient } from "pg";
import type { DirectorySession } from "../../../shared-directory/model";
import type { ApprovedAccountAccessSnapshot } from "../../../shared-directory/approved-account-access-source";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { COMMERCIAL_COMPANY_MODULE_KEYS } from "../domain/company-context";
import { HttpError } from "../../../utils/httpError";
import { assertCurrentBusinessCompanyOwner, repoSetBusinessCompanyMembershipTx } from "./company-directory.repository";

type Queryer = Pick<PoolClient, "query">;
export type ApprovedSourceBinding = {
  profile_id: string;
  site: "cerp_prod" | "cerp_test";
  membership_version: number;
};
export type ApprovedCompanySelection = {
  company_id: string;
  expected_company_version: number;
  expected_membership_version: number;
  enabled: boolean;
};
export type ApprovedCompanyAccessInput = {
  source_site: "cerp_prod" | "cerp_test";
  source_membership_version: number;
  source_hash: string;
  company_access: ApprovedCompanySelection[];
};
type Row = {
  company_id: string;
  code: string;
  name: string;
  profile: "COMMERCIAL" | "INDUSTRIAL";
  status: string;
  version: number;
  enabled_module_keys: string[];
  enabled_commercial_projection_capabilities: string[];
  membership_version: number;
  membership_status: string | null;
  denied_module_keys: string[];
  membership_capabilities: string[] | null;
  prod_ready: boolean;
  test_ready: boolean;
  primary_company: boolean;
};
const conflict = () => new HttpError(409, "BUSINESS_COMPANY_CONFIGURATION_CONFLICT", "Les droits ou entreprises ont changé. Rechargez la fiche avant de confirmer.");

/** Production approval is preferred; a genuinely Test-only account keeps its
 * own approved source. This lookup never creates a global site membership. */
export async function repoReadApprovedSourceBinding(db: Queryer, profileId: string): Promise<ApprovedSourceBinding> {
  const row = (await db.query<ApprovedSourceBinding>(
    `SELECT p.profile_id::text,m.database_id AS site,m.version AS membership_version
     FROM public.cerp_directory_profiles p JOIN public.users u ON u.id=p.user_id
     JOIN public.cerp_directory_memberships m ON m.profile_id=p.profile_id
     WHERE p.profile_id=$1::uuid AND u.status='Active' AND m.status='Active'
       AND m.database_id IN ('cerp_prod','cerp_test')
       AND NOT EXISTS(SELECT 1 FROM public.cerp_directory_memberships disabled
         WHERE disabled.profile_id=p.profile_id AND disabled.database_id='cerp_prod' AND disabled.status<>'Active')
     ORDER BY CASE m.database_id WHEN 'cerp_prod' THEN 0 ELSE 1 END LIMIT 1`, [profileId],
  )).rows[0];
  if (!row) throw new HttpError(409, "BUSINESS_COMPANY_APPROVED_SOURCE_REQUIRED", "Ce compte doit disposer de droits validés avant son rattachement.");
  return row;
}

async function readRows(db: Queryer, profileId: string): Promise<Row[]> {
  return (await db.query<Row>(
    `SELECT c.company_id::text,c.code,c.name,c.profile,c.status,c.version,c.enabled_module_keys,c.enabled_commercial_projection_capabilities,
       coalesce(m.version,0) AS membership_version,m.status AS membership_status,
       coalesce(m.denied_module_keys,ARRAY[]::text[]) AS denied_module_keys,
       m.enabled_commercial_projection_capabilities AS membership_capabilities,
       EXISTS(SELECT 1 FROM public.cerp_business_company_instances i WHERE i.company_id=c.company_id AND i.environment='cerp_prod' AND i.active) AS prod_ready,
       EXISTS(SELECT 1 FROM public.cerp_business_company_instances i WHERE i.company_id=c.company_id AND i.environment='cerp_test' AND i.active) AS test_ready
       ,EXISTS(SELECT 1 FROM public.cerp_business_company_instances i WHERE i.company_id=c.company_id AND i.site_id='cerp_prod') AS primary_company
     FROM public.cerp_business_companies c LEFT JOIN public.cerp_business_company_memberships m ON m.company_id=c.company_id AND m.profile_id=$1::uuid
     WHERE c.status='ACTIVE'
     ORDER BY c.company_id`, [profileId],
  )).rows;
}
export function approvedCompanyProposal(row: Row, approvedModules: readonly string[]) {
  const approved = new Set(approvedModules), commercial = new Set<string>(COMMERCIAL_COMPANY_MODULE_KEYS);
  const allowed = row.enabled_module_keys.filter(key => approved.has(key) && (row.profile !== "COMMERCIAL" || commercial.has(key))).sort();
  const denies = new Set(row.denied_module_keys);
  // Existing exceptions, including disabled projections, survive a normal save.
  const caps = (row.membership_capabilities ?? row.enabled_commercial_projection_capabilities)
    .filter(cap => row.enabled_commercial_projection_capabilities.includes(cap)).sort();
  return {
    company_id: row.company_id, code: row.code, name: row.name, profile: row.profile,
    expected_company_version: row.version,
    expected_membership_version: row.membership_version,
    selected: row.membership_status === "ACTIVE",
    allowed_module_keys: allowed, denied_module_keys: row.denied_module_keys,
    effective_module_keys: allowed.filter(key => !denies.has(key)),
    enabled_commercial_projection_capabilities: caps,
    deployment: { cerp_prod: row.prod_ready, cerp_test: row.test_ready },
  };
}
export async function repoReadApprovedCompanyOptions(db: Queryer, binding: ApprovedSourceBinding, snapshot: ApprovedAccountAccessSnapshot) {
  return {
    profile_id: binding.profile_id,
    source: { site: binding.site, membership_version: binding.membership_version, epoch: snapshot.source_epoch, hash: snapshot.source_hash },
    companies: (await readRows(db, binding.profile_id)).map(row => approvedCompanyProposal(row, snapshot.module_keys)),
  };
}

/** One connection owns all locks, version checks, projections and audit rows.
 * A stale second selection rolls back the entire operation. No user-provided
 * module keys or inherited superadmin flag enter this mutation. */
export async function repoApplyApprovedCompanyAccess(
  db: Pool, binding: ApprovedSourceBinding, snapshot: ApprovedAccountAccessSnapshot,
  input: ApprovedCompanyAccessInput, actor: DirectorySession,
) {
  if (snapshot.profile_id !== binding.profile_id || snapshot.source_site !== binding.site)
    throw new HttpError(503, "DIRECTORY_UNAVAILABLE", "Les droits approuvés sont momentanément indisponibles.");
  if (input.source_site !== binding.site || input.source_membership_version !== binding.membership_version || input.source_hash !== snapshot.source_hash)
    throw conflict();
  return withRealtimeOutboxTransaction(await db.connect(), async tx => {
    await assertCurrentBusinessCompanyOwner(tx, actor);
    const source = (await tx.query<{ version: number; status: string }>(
      `SELECT m.version,m.status FROM public.cerp_directory_memberships m
       JOIN public.cerp_directory_profiles p ON p.profile_id=m.profile_id JOIN public.users u ON u.id=p.user_id
       WHERE m.profile_id=$1::uuid AND m.database_id=$2 AND u.status='Active' FOR UPDATE OF m,p,u`,
      [binding.profile_id, binding.site],
    )).rows[0];
    if (!source || source.status !== "Active" || source.version !== binding.membership_version) throw conflict();
    const selections = [...input.company_access].sort((a, b) => a.company_id.localeCompare(b.company_id));
    // All competitors, including the existing advanced edit route, use this lock.
    for (const selection of selections) {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`business-company-membership:${selection.company_id}:${binding.profile_id}`]);
      await tx.query("SELECT company_id FROM public.cerp_business_companies WHERE company_id=$1::uuid FOR UPDATE", [selection.company_id]);
    }
    const rows = await readRows(tx, binding.profile_id), byId = new Map(rows.map(row => [row.company_id, row]));
    // Check every item before the first write; transaction rollback is still the
    // final guard if any subsequent constraint/projection/audit operation fails.
    for (const selection of selections) {
      const row = byId.get(selection.company_id);
      if (!row || row.version !== selection.expected_company_version || row.membership_version !== selection.expected_membership_version) throw conflict();
      if (selection.enabled && row.status !== "ACTIVE") throw conflict();
      if (!selection.enabled && row.membership_status === "ACTIVE" && row.primary_company && binding.profile_id === actor.profile_id)
        throw new HttpError(409, "BUSINESS_COMPANY_OWNER_SELF_ACCESS_REQUIRED", "Conservez votre accès à l’entreprise principale pour administrer les comptes.");
    }
    for (const selection of selections) {
      const row = byId.get(selection.company_id)!;
      if (!selection.enabled && row.membership_status !== "ACTIVE") continue;
      const proposal = approvedCompanyProposal(row, snapshot.module_keys);
      await repoSetBusinessCompanyMembershipTx(tx, {
        company_id: row.company_id, profile_id: binding.profile_id,
        status: selection.enabled ? "ACTIVE" : "REVOKED",
        allowed_module_keys: proposal.allowed_module_keys,
        denied_module_keys: row.denied_module_keys,
        enabled_commercial_projection_capabilities: proposal.enabled_commercial_projection_capabilities,
        expected_version: row.membership_version,
      }, { user_id: actor.source_user_id, ip: null, user_agent: null, device_type: null, os: null, browser: null });
    }
    return repoReadApprovedCompanyOptions(tx, binding, snapshot);
  });
}
