import type { PoolClient } from "pg";
import { laterScheduleConversions } from "../../demand-pilot/repository/demand-forecast-conversion";
import {
  parseCumpDecimal as qty,
  formatCumpDecimal as fmt,
} from "../../stock/domain/cump-decimal";
import type { IndustrialDemand } from "../types/industrial-plan.types";

type Db = Pick<PoolClient, "query">;
type Schedule = {
  forecast_id: string;
  id: string;
  due: string;
  quantity: string;
  quantity_basis: "REMAINING" | "TOTAL";
};
/** The commercial catalogue stores one row per month. Restore dates only where pilot evidence
 * exactly reconciles with its remaining quantity. Never subtract a PRV/remaining quantity twice. */
export async function expandPilotForecasts(
  db: Db,
  demand: IndustrialDemand[],
  issues: Set<string>,
) {
  const ids = demand
    .filter((d) => d.kind === "FORECAST" && d.id.startsWith("forecast:"))
    .map((d) => d.id.slice(9));
  if (!ids.length) return demand;
  const schedules = (
    await db.query<Schedule>(
      `SELECT b.forecast_id,r.id,COALESCE(r.accepted_need_date,r.need_date)::text AS due,greatest(0,r.quantity-${laterScheduleConversions})::text AS quantity,r.quantity_basis
  FROM public.demand_pilot_forecast_bindings b JOIN public.demand_pilot_revisions r ON r.contract_line_id=b.contract_line_id
  AND date_trunc('month',COALESCE(r.accepted_need_date,r.need_date))::date=b.month
  WHERE b.forecast_id=ANY($1::uuid[]) AND r.status='MATERIALIZED' AND r.kind='FORECAST'
   AND NOT EXISTS(SELECT 1 FROM public.demand_pilot_revisions later WHERE later.client_id=r.client_id AND later.external_site=r.external_site
    AND later.external_order_key=r.external_order_key AND later.external_line_key=r.external_line_key AND later.external_schedule_key=r.external_schedule_key
    AND later.kind='FORECAST' AND later.status='MATERIALIZED' AND later.revision_no>r.revision_no)
  ORDER BY b.forecast_id,due,r.id`,
      [ids],
    )
  ).rows;
  const result: IndustrialDemand[] = [];
  for (const d of demand) {
    const rows =
      d.kind === "FORECAST"
        ? schedules.filter((r) => d.id === "forecast:" + r.forecast_id)
        : [];
    if (!rows.length) {
      result.push(d);
      continue;
    }
    const total = rows.reduce((v, r) => v + qty(r.quantity), 0n);
    if (total === qty(d.quantity)) {
      for (const r of rows)
        result.push({
          ...d,
          id: d.id + ":" + r.id,
          quantity: r.quantity,
          due: r.due,
        });
    } else if (rows.length === 1) {
      result.push({ ...d, due: rows[0].due });
    } else {
      issues.add(
        "Répartition hebdomadaire à rapprocher pour la prévision " +
          d.id +
          " ; couverture mensuelle conservée.",
      );
      result.push(d);
    }
  }
  return result;
}
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
  const residualIds = new Set(
    (
      await db.query<{ forecast_id: string }>(
        `SELECT DISTINCT b.forecast_id FROM public.demand_pilot_forecast_bindings b JOIN public.demand_pilot_revisions r
  ON r.contract_line_id=b.contract_line_id AND date_trunc('month',COALESCE(r.accepted_need_date,r.need_date))::date=b.month
  WHERE r.status='MATERIALIZED' AND r.quantity_basis='REMAINING' AND b.forecast_id=ANY($1::uuid[])`,
        [forecasts.map((f) => f.id.split(":")[1])],
      )
    ).rows.map((r) => r.forecast_id),
  );
  return demand
    .map((d) => {
      if (
        d.kind !== "FORECAST" ||
        !d.contractLine ||
        residualIds.has(d.id.split(":")[1])
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
