import type { PoolClient } from "pg";
import type {
  IndustrialContractRule,
  IndustrialDemand,
} from "../types/industrial-plan.types";

/** One statistical scenario per article/contract/month. No customer order or forecast row is written. */
export async function historySuggestions(
  db: Pick<PoolClient, "query">,
  input: {
    client: string;
    start: string;
    end: string;
    today: string;
    rules: IndustrialContractRule[];
    demand: IndustrialDemand[];
  },
) {
  const rules = input.rules.filter(
    (r) => r.clientId === input.client && r.useHistory,
  );
  if (!rules.length) return [];
  const rows = (
    await db.query<{ article: string; unit: string; quantity: string }>(
      `SELECT ordered.article_id::text AS article,upper(trim(l.unite)) AS unit,
 round(sum(l.quantite)/12,3)::text AS quantity FROM public.bon_livraison_ligne l JOIN public.bon_livraison b ON b.id=l.bon_livraison_id
 LEFT JOIN public.commande_ligne ordered ON ordered.id=l.commande_ligne_id WHERE b.client_id=$1 AND b.statut IN('SHIPPED','DELIVERED')
 AND b.date_expedition>=date_trunc('month',$2::date)-interval '12 months' AND b.date_expedition<date_trunc('month',$2::date)
 AND ordered.article_id=ANY($3::uuid[]) GROUP BY 1,2`,
      [input.client, input.today, rules.map((r) => r.article)],
    )
  ).rows;
  const months = (
    await db.query<{ due: string }>(
      `SELECT (m+interval '1 month'-interval '1 day')::date::text AS due FROM generate_series(
 date_trunc('month',greatest($1::date,$2::date)),date_trunc('month',$3::date),interval '1 month')m ORDER BY m`,
      [input.start, input.today, input.end],
    )
  ).rows;
  const result: IndustrialDemand[] = [];
  for (const row of rows) {
    const eligible = input.rules.filter(
      (r) => r.clientId === input.client && r.article === row.article,
    );
    if (eligible.length !== 1 || !eligible[0].useHistory) continue;
    const rule = eligible[0];
    for (const { due } of months) {
      const month = due.slice(0, 7),
        actual = input.demand.filter(
          (d) =>
            d.contractLine === rule.id &&
            d.article === row.article &&
            d.unit === row.unit &&
            d.due.startsWith(month),
        );
      if (actual.some((d) => d.kind === "FORECAST")) continue;
      const quantity =
        Number(row.quantity) -
        actual
          .filter((d) => d.kind === "FIRM")
          .reduce((v, d) => v + Number(d.quantity), 0);
      if (quantity > 0)
        result.push({
          id: "history:" + rule.id + ":" + month,
          kind: "FORECAST",
          historical: true,
          article: row.article,
          unit: row.unit,
          contractLine: rule.id,
          orderLine: null,
          allocation: null,
          quantity: quantity.toFixed(3),
          due,
          priceEur: null,
        });
    }
  }
  return result;
}
