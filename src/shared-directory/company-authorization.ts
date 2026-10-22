import type { Pool } from "pg";
import { HttpError } from "../utils/httpError";
import type { DirectorySession } from "./model";
import { isDirectoryOwner, requireDirectoryOwner, requireDirectoryRecentMfa } from "./authority";
import { readCommonAccessSource } from "./common-access";

/** The shared company keeps its Directory authority; delegation comes from current Production ACLs. */
export async function requireDirectoryCompanyConfiguration(
  db: Pool,
  actor: DirectorySession,
  authorityId: string,
  keys: ReadonlyMap<string, string>,
  transport?: typeof fetch,
) {
  if (await isDirectoryOwner(db, actor)) {
    await requireDirectoryOwner(db, actor);
    return;
  }
  requireDirectoryRecentMfa(actor);
  const production = await db.query("SELECT 1 FROM public.cerp_directory_memberships WHERE profile_id=$1::uuid AND database_id='cerp_prod' AND status='Active'", [actor.profile_id]);
  if (!production.rows.length) throw new HttpError(403, "ERP_CONFIGURATION_REQUIRED", "Le droit Paramétrage ERP est requis.");
  const key = keys.get("cerp_prod");
  if (!key) throw new HttpError(503, "DIRECTORY_UNAVAILABLE", "Les droits communs sont momentanément indisponibles.");
  const policy = await readCommonAccessSource({ authority_id: authorityId, profile_id: actor.profile_id, target_site: actor.database }, key, transport);
  if (!policy.modules.some(module => module.module_key === "parametrage-erp" && module.allowed)) {
    throw new HttpError(403, "ERP_CONFIGURATION_REQUIRED", "Le droit Paramétrage ERP est requis.");
  }
}
