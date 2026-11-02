import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { IndustrialDemand } from "../../planning/types/industrial-plan.types";
import type { DemandRow } from "../types/demand-pilot.types";
import { laterScheduleConversions } from "../repository/demand-forecast-conversion";

/** Changes are applied only to exact commercial bindings, in the simulation copy. */
export async function scenarioInput(
  tx: PoolClient,
  row: DemandRow,
  book: IndustrialDemand[],
) {
  const identity = [
    row.client_id,
    row.external_site,
    row.external_order_key,
    row.external_line_key,
    row.external_schedule_key,
  ];
  if (row.diff_type === "REMOVED")
    throw new HttpError(
      409,
      "MISSING_REVIEW",
      "Une absence exige une décision explicite avant simulation.",
    );
  const bound = (
    await tx.query<{
      allocation: string;
      line: string;
      article: string;
      shipped: string;
    }>(
      `SELECT r.allocation_id::text allocation,r.line_id::text line,b.article_id::text article,
    (SELECT COALESCE(sum(s.quantity),0)::text FROM public.delivery_promise_parts p JOIN public.delivery_promise_shipments s ON s.part_id=p.id WHERE p.root_id=r.id) shipped
    FROM public.demand_pilot_firm_binding_scopes b JOIN public.delivery_promise_roots r ON r.id=b.promise_root_id
    WHERE b.client_id=$1 AND b.external_site=$2 AND b.external_order_key=$3 AND b.external_line_key=$4 AND b.external_schedule_key=$5`,
      identity,
    )
  ).rows[0];
  let quantity = Number(row.quantity);
  if (bound && (row.kind !== "FIRM" || row.article_id !== bound.article))
    throw new HttpError(
      409,
      "BOUND_CHANGE_REVIEW",
      "Vérifier la modification d’une échéance ferme déjà rattachée.",
    );
  if (bound && row.quantity_basis === "TOTAL")
    quantity = Math.max(
      0,
      Math.round((quantity - Number(bound.shipped)) * 1000) / 1000,
    );
  if (
    bound &&
    book.some(
      (d) => d.kind === "FIRM" && d.orderLine === bound.line && !d.allocation,
    )
  )
    throw new HttpError(
      409,
      "BOUND_ALLOCATION_REVIEW",
      "Le carnet ne détaille pas les échéances de cette ligne ferme. Vérifier la répartition.",
    );
  const prior = (
    await tx.query<{
      id: string;
      forecast_id: string;
      converted: string;
      draft_lines: string[];
    }>(
      `SELECT r.id::text,b.forecast_id::text,${laterScheduleConversions}::text AS converted,
      ARRAY(SELECT dl.commande_ligne_id::text FROM public.demand_pilot_firm_draft_lines dl JOIN public.demand_pilot_revisions firm ON firm.id=dl.revision_id
        WHERE (firm.client_id,firm.external_site,firm.external_order_key,firm.external_line_key,firm.external_schedule_key)=
          (r.client_id,r.external_site,r.external_order_key,r.external_line_key,r.external_schedule_key)) AS draft_lines
      FROM public.demand_pilot_revisions r
    JOIN public.demand_pilot_forecast_bindings b ON b.contract_line_id=r.contract_line_id
     AND b.month=date_trunc('month',COALESCE(r.accepted_need_date,r.need_date))::date
    WHERE r.client_id=$1 AND r.external_site=$2 AND r.external_order_key=$3 AND r.external_line_key=$4 AND r.external_schedule_key=$5
      AND r.kind='FORECAST' AND r.status='MATERIALIZED' AND r.revision_no<=$6 ORDER BY r.revision_no DESC LIMIT 1`,
      [...identity, row.revision_no],
    )
  ).rows[0];
  if (prior && book.some((d) => d.id === "forecast:" + prior.forecast_id))
    throw new HttpError(
      409,
      "BOUND_FORECAST_REVIEW",
      "La prévision mensuelle n’est pas ventilée par échéance. Vérifier le reliquat.",
    );
  const forecastKey = prior && "forecast:" + prior.forecast_id + ":" + prior.id;
  if (
    !bound &&
    prior?.draft_lines?.some((id) =>
      book.some((d) => d.kind === "FIRM" && d.orderLine === id),
    )
  )
    throw new HttpError(
      409,
      "BOUND_FIRM_REVIEW",
      "Rattachez l’échéance à la promesse de la commande ferme existante.",
    );
  const converted = Number(prior?.converted ?? 0);
  if (row.kind === "FORECAST" && row.quantity_basis === "TOTAL")
    quantity = Math.max(0, quantity - converted);
  const retained = book.flatMap((d) => {
    if (bound && d.kind === "FIRM" && d.allocation === bound.allocation)
      return [];
    if (d.id !== forecastKey) return [d];
    if (row.kind === "FORECAST") return [];
    const remaining =
      Math.round(
        (Number(d.quantity) - Math.max(0, quantity - converted)) * 1000,
      ) / 1000;
    return remaining > 0 ? [{ ...d, quantity: String(remaining) }] : [];
  });
  return { retained, quantity: String(quantity), bound, forecastKey };
}
