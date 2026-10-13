import type { DbQueryer } from "./of-versioning.repository";
import { readReplenishmentPlanningTargets } from "../../planning/repository/planning-replenishment-targets.repository";

/** Read the original target on the document transaction; never substitute a forecast finish. */
export async function readOfDocumentInternalDue(tx: DbQueryer, ofIds: readonly number[]): Promise<string | null> {
  const ids = [...new Set(ofIds)];
  const rows = (await tx.query<{ internal_due: string | null }>(`
    SELECT (CASE WHEN command.order_type='INTERNE'
      THEN COALESCE(line.delai_interne,line.delai_client) ELSE line.delai_interne END)::text AS internal_due
    FROM public.ordres_fabrication source
    LEFT JOIN public.commande_client command ON command.id=source.commande_id
    LEFT JOIN public.commande_ligne line ON line.id=source.commande_ligne_id
    WHERE source.id=ANY($1::bigint[])`, [ids])).rows;
  const targets = await readReplenishmentPlanningTargets(tx, ids);
  const dates = [...rows.flatMap(row => row.internal_due ? [row.internal_due] : []), ...targets.values()];
  return dates.sort()[0] ?? null;
}
