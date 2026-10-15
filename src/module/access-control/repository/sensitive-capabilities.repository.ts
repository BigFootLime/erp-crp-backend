import pool from "../../../config/database";
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
