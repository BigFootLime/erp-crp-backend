import type { PoolClient } from "pg";
import {
  parseCumpDecimal as qty,
  formatCumpDecimal as fmt,
} from "../../stock/domain/cump-decimal";
import type { IndustrialDemand } from "../types/industrial-plan.types";

type Db = Pick<PoolClient, "query">;
/** Legacy calls without an explicit conversion may consume one gross estimate in the same contract/week.
 * Remaining-to-deliver programmes contain distinct PRV columns; they require an explicit conversion. */
export async function consumeGrossForecasts(
  db: Db,
  demand: IndustrialDemand[],
  issues: Set<string>,
) {
  const lineIds = demand.flatMap((d) =>
    d.kind === "FIRM" && d.orderLine ? [d.orderLine] : [],
  );
  if (!lineIds.length) return demand;
  const committed = (
    await db.query<{ line_id: string; allocated: string }>(
      `SELECT call.commande_ligne_id::text AS line_id,COALESCE(sum(a.quantity),0)::text AS allocated
  FROM public.client_contract_call_lines call LEFT JOIN public.client_forecast_call_allocations a ON a.call_line_id=call.id
  WHERE call.commande_ligne_id=ANY($1::bigint[]) GROUP BY call.commande_ligne_id`,
      [lineIds],
    )
  ).rows;
  const explicit = new Map(committed.map((c) => [c.line_id, qty(c.allocated)]));
  const week = (day: string) => {
    const d = new Date(day + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const scope = (d: IndustrialDemand) =>
    JSON.stringify([d.contractLine, d.article, d.unit, week(d.due)]);
  const gross = new Map<string, bigint>();
  for (const d of demand.filter(
    (d) => d.kind === "FIRM" && d.contractLine && d.orderLine,
  )) {
    const amount = qty(d.quantity),
      linked = explicit.get(d.orderLine!) ?? 0n,
      consumed = linked < amount ? linked : amount;
    explicit.set(d.orderLine!, linked - consumed);
    gross.set(scope(d), (gross.get(scope(d)) ?? 0n) + amount - consumed);
  }
  const forecasts = demand.filter((d) => d.kind === "FORECAST");
  return demand
    .map((d) => {
      if (
        d.kind !== "FORECAST" ||
        !d.contractLine
      )
        return d;
      const key = scope(d),
        unlinked = gross.get(key) ?? 0n;
      if (!unlinked) return d;
      if (forecasts.filter((f) => scope(f) === key).length !== 1) {
        issues.add(
          "Conversion ambiguë entre plusieurs prévisions : " +
            d.contractLine +
            ".",
        );
        return d;
      }
      const covered = qty(d.quantity) < unlinked ? qty(d.quantity) : unlinked;
      gross.set(key, unlinked - covered);
      return { ...d, quantity: fmt(qty(d.quantity) - covered) };
    })
    .filter((d) => qty(d.quantity) > 0n);
}
