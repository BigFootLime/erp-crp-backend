import type { DbQueryer } from "./of-versioning.repository";
import { readReplenishmentPlanningTargets } from "../../planning/repository/planning-replenishment-targets.repository";

/** Read the original target on the document transaction; never substitute a forecast finish. */
export async function readOfDocumentInternalDue(tx: DbQueryer, ofIds: readonly number[]): Promise<string | null> {
  const ids = [...new Set(ofIds)];
  const rows = (await tx.query<{ internal_due: string | null }>(`
    SELECT COALESCE(line.delai_interne,line.delai_client)::text AS internal_due
    FROM public.ordres_fabrication source
    LEFT JOIN public.commande_ligne line ON line.id=source.commande_ligne_id
    WHERE source.id=ANY($1::bigint[])`, [ids])).rows;
  // A sub-OF with no separate internal target still inherits the requested line deadline.
  // Its lack of a delivery affair must not remove this deadline from the workshop sheet.
  const targets = await readReplenishmentPlanningTargets(tx, ids);
  const dates = [...rows.flatMap(row => row.internal_due ? [row.internal_due] : []), ...targets.values()];
  return dates.sort()[0] ?? null;
}
