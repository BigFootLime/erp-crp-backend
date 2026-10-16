import pool from "../../../config/database";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { isSensitiveCapability, SENSITIVE_CAPABILITIES, type AccountCapabilityState } from "../domain/sensitive-capabilities";

/** Live state is authoritative; neither role, JWT claims nor module grants grant privileges. */
export async function repoAccountSensitiveCapabilities(userId: number): Promise<AccountCapabilityState> {
  const { rows } = await pool.query<{ status: string | null; is_superadmin: boolean }>(
    "SELECT status, COALESCE(is_superadmin, false) AS is_superadmin FROM public.users WHERE id = $1",
    [userId],
  );
  const account = rows[0];
  if (!account || account.status !== "Active") return { active: false, isSuperadmin: false, capabilities: [] };
  // This existing, live marker preserves access to recovery/administration even
  // before the additive patch. It is never inferred from a supplied role.
  if (account.is_superadmin) return { active: true, isSuperadmin: true, capabilities: SENSITIVE_CAPABILITIES };
  try {
    const grants = await pool.query<{ capability: string }>(
      "SELECT capability FROM public.app_user_sensitive_capabilities WHERE user_id = $1 AND granted = true ORDER BY capability",
      [userId],
    );
    return { active: true, isSuperadmin: false, capabilities: grants.rows.map(row => row.capability).filter(isSensitiveCapability) };
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") {
      throw new HttpError(503, "SENSITIVE_ACCESS_NOT_READY", "Le registre des habilitations sensibles doit être installé.");
    }
    throw error;
  }
}

/** Used only while projecting a newly approved Directory account before it is activated. */
export async function repoGrantSensitiveCapabilities(
  tx: Pick<PoolClient, "query">,
  params: { userId: number; capabilities: readonly (typeof SENSITIVE_CAPABILITIES)[number][]; updatedBy: number },
): Promise<void> {
  for (const capability of params.capabilities) {
    await tx.query(
      `INSERT INTO public.app_user_sensitive_capabilities(user_id, capability, granted, updated_by)
       VALUES($1, $2, true, $3)
       ON CONFLICT(user_id, capability) DO UPDATE SET
         granted = true,
         updated_by = EXCLUDED.updated_by,
         updated_at = now(),
         version = public.app_user_sensitive_capabilities.version + 1
       WHERE public.app_user_sensitive_capabilities.granted IS DISTINCT FROM true`,
      [params.userId, capability, params.updatedBy],
    );
  }
}
