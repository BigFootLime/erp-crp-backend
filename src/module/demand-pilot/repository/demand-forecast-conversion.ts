import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";

/** SQL scope: r is a source forecast revision. Only subsequent firm conversions
 * of the exact external schedule may consume a reported remaining quantity. */
export const laterScheduleConversions = `COALESCE((
  SELECT sum(a.quantity) FROM public.demand_pilot_revisions firm
  JOIN public.demand_pilot_firm_draft_lines dl ON dl.revision_id=firm.id
  JOIN public.client_contract_call_lines cl ON cl.commande_ligne_id=dl.commande_ligne_id
  JOIN public.client_forecast_call_allocations a ON a.call_line_id=cl.id
  JOIN public.demand_pilot_forecast_bindings fb ON fb.forecast_id=a.forecast_id AND fb.contract_line_id=r.contract_line_id
  WHERE (firm.client_id,firm.external_site,firm.external_order_key,firm.external_line_key,firm.external_schedule_key)
      =(r.client_id,r.external_site,r.external_order_key,r.external_line_key,r.external_schedule_key)
    AND firm.revision_no>r.revision_no AND fb.month=date_trunc('month',COALESCE(r.accepted_need_date,r.need_date))::date
),0)`;

export async function forecastForFirmDraft(tx: PoolClient, revisionId: string) {
  const result = await tx.query<{
    forecast_id: string;
    expected_version: number;
    quantity: number;
  }>(
    `
    SELECT b.forecast_id::text, f.version AS expected_version,
      LEAST(firm.quantity,greatest(0,r.quantity-${laterScheduleConversions}),cov.remaining_quantity)::float8 quantity
    FROM public.demand_pilot_revisions firm
    JOIN LATERAL (SELECT prev.* FROM public.demand_pilot_revisions prev WHERE
      (prev.client_id,prev.external_site,prev.external_order_key,prev.external_line_key,prev.external_schedule_key)=
      (firm.client_id,firm.external_site,firm.external_order_key,firm.external_line_key,firm.external_schedule_key)
      AND prev.revision_no<firm.revision_no AND prev.kind='FORECAST' AND prev.status='MATERIALIZED'
      ORDER BY prev.revision_no DESC LIMIT 1) r ON true
    JOIN public.demand_pilot_forecast_bindings b ON b.contract_line_id=r.contract_line_id AND b.month=date_trunc('month',COALESCE(r.accepted_need_date,r.need_date))::date
    JOIN public.client_contract_forecasts f ON f.id=b.forecast_id AND f.status='ACTIVE'
    JOIN public.v_client_contract_forecast_coverage cov ON cov.forecast_id=f.id
    WHERE firm.id=$1 AND firm.contract_line_id=r.contract_line_id AND firm.article_id=r.article_id
    FOR UPDATE OF f`,
    [revisionId],
  );
  if (result.rows.length > 1)
    throw new HttpError(
      409,
      "CARCO_FORECAST_AMBIGUOUS",
      "Plusieurs prévisions correspondent à cet appel ferme.",
    );
  return result.rows.filter((r) => r.quantity > 0);
}
