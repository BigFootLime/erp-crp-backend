import { createHash } from "node:crypto";
import { z } from "zod";
import type { Pool } from "pg";
import { withRealtimeOutboxTransaction } from "../shared/realtime/realtime-outbox-transaction";
import {
  repoListCatalogModules,
  repoUpsertUserModuleAccess,
} from "../module/access-control/repository/access-control.repository";
import { repoInsertAuditLog } from "../module/audit-logs/repository/audit-logs.repository";
import type { DirectoryClient } from "./client";
import { HttpError } from "../utils/httpError";

const unavailable = () =>
  new HttpError(
    503,
    "COMPANY_POLICY_UNAVAILABLE",
    "La politique entreprise est momentanément indisponible.",
  );
const schema = z
  .object({
    authority_id: z.string().uuid(),
    profile_id: z.string().uuid(),
    company_id: z.string().uuid(),
    environment: z.enum(["cerp_prod", "cerp_test"]),
    target_site: z.string().min(1),
    company_version: z.number().int().positive(),
    membership_version: z.number().int().positive(),
    instance_version: z.number().int().positive(),
    modules: z.array(z.string().min(1).max(100)).max(100),
    policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
    request_nonce: z.string().uuid(),
    issued_at: z.number().int().positive(),
  })
  .strict();
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Projects only explicit company grants. Sensitive capabilities and superadmin are never inherited. */
export async function synchronizeCompanyPolicy(
  db: Pool,
  directory: DirectoryClient,
  params: {
    session: string;
    profileId: string;
    userId: number;
    site: string;
    authorityId: string;
    expectedCompanyId: string;
    expectedEnvironment: "cerp_prod" | "cerp_test";
  },
) {
  try {
    const policy = schema.parse(
      await directory.businessCompanyPolicy(params.session),
    );
    const body = {
      authority_id: policy.authority_id,
      profile_id: policy.profile_id,
      company_id: policy.company_id,
      environment: policy.environment,
      target_site: policy.target_site,
      company_version: policy.company_version,
      membership_version: policy.membership_version,
      instance_version: policy.instance_version,
      modules: policy.modules,
    };
    if (
      policy.authority_id !== params.authorityId ||
      policy.profile_id !== params.profileId ||
      policy.target_site !== params.site ||
      policy.company_id !== params.expectedCompanyId ||
      policy.environment !== params.expectedEnvironment ||
      Math.abs(Math.floor(Date.now() / 1000) - policy.issued_at) > 20 ||
      policy.policy_hash !== hash(body) ||
      new Set(policy.modules).size !== policy.modules.length
    )
      throw unavailable();
    await withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `company-policy:${policy.profile_id}:${policy.company_id}:${policy.environment}:${policy.target_site}`,
      ]);
      const local = (
        await tx.query<{ id: number }>(
          "SELECT id FROM public.users WHERE id=$1 AND directory_profile_id=$2::uuid AND status='Active' FOR UPDATE",
          [params.userId, policy.profile_id],
        )
      ).rows[0];
      if (!local) throw unavailable();
      const prior = (
        await tx.query<any>(
          "SELECT company_version,membership_version,instance_version,policy_hash FROM public.cerp_company_policy_projections WHERE profile_id=$1::uuid AND company_id=$2::uuid AND environment=$3 AND target_site=$4 FOR UPDATE",
          [
            policy.profile_id,
            policy.company_id,
            policy.environment,
            policy.target_site,
          ],
        )
      ).rows[0];
      if (prior) {
        const old = [
            Number(prior.company_version),
            Number(prior.membership_version),
            Number(prior.instance_version),
          ],
          next = [
            policy.company_version,
            policy.membership_version,
            policy.instance_version,
          ];
        if (old.some((v, i) => next[i] < v)) throw unavailable();
        // Equal authority revisions must describe the identical policy. Accepting
        // a different hash here would turn a stale/replayed response into a grant.
        if (old.every((v, i) => next[i] === v)) {
          if (prior.policy_hash !== policy.policy_hash) throw unavailable();
          return;
        }
      }
      const catalog = await repoListCatalogModules(tx),
        known = new Set(catalog.map((m) => m.module_key));
      if (policy.modules.some((key) => !known.has(key))) throw unavailable();
      const allowed = new Set(policy.modules);
      const current = new Map(
        (
          await tx.query<{ module_key: string; access: string }>(
            "SELECT module_key,access FROM public.app_module_user_access WHERE user_id=$1",
            [local.id],
          )
        ).rows.map((r) => [r.module_key, r.access]),
      );
      for (const module of catalog) {
        // Protected modules stay denied even if a malformed central response names one.
        const access =
          module.is_active &&
          !module.is_protected &&
          allowed.has(module.module_key)
            ? "GRANTED"
            : "DENIED";
        if (current.get(module.module_key) !== access)
          await repoUpsertUserModuleAccess(tx, {
            userId: local.id,
            moduleKey: module.module_key,
            access,
            updatedBy: local.id,
          });
      }
      await tx.query(
        `INSERT INTO public.cerp_company_policy_projections(profile_id,company_id,environment,target_site,company_version,membership_version,instance_version,policy_hash)
    VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8) ON CONFLICT(profile_id,company_id,environment,target_site) DO UPDATE SET company_version=excluded.company_version,membership_version=excluded.membership_version,instance_version=excluded.instance_version,policy_hash=excluded.policy_hash,projected_at=now()`,
        [
          policy.profile_id,
          policy.company_id,
          policy.environment,
          policy.target_site,
          policy.company_version,
          policy.membership_version,
          policy.instance_version,
          policy.policy_hash,
        ],
      );
      await repoInsertAuditLog({
        tx,
        user_id: local.id,
        ip: null,
        user_agent: null,
        device_type: null,
        os: null,
        browser: null,
        body: {
          event_type: "ACTION",
          action: "DIRECTORY_COMPANY_POLICY_PROJECTED",
          page_key: "administration-acces",
          entity_type: "directory_profile",
          entity_id: policy.profile_id,
          path: "/internal/directory/business-company-policy",
          details: {
            company_id: policy.company_id,
            environment: policy.environment,
            target_site: policy.target_site,
            company_version: policy.company_version,
            membership_version: policy.membership_version,
            instance_version: policy.instance_version,
            policy_hash: policy.policy_hash,
          },
        },
      });
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}
