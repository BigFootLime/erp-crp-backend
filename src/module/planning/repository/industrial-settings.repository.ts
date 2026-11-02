import type { PoolClient } from "pg";
import type { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { industrialSettingsSchema } from "../validators/industrial-plan.validators";
import { readIndustrialPolicy } from "./industrial-policy.repository";

export async function getIndustrialSettings(
  db: Pick<PoolClient, "query">,
  clientId: string,
) {
  const articles = (
    await db.query(
      `SELECT DISTINCT a.id::text AS article_id,a.code,a.designation,COALESCE(r.family,a.family_code,a.article_type) AS family,
 r.lead_days,r.unit_cost_eur::float8,
 CASE WHEN a.piece_technique_id IS NOT NULL
             AND (r.article_id IS NULL OR r.yield_qualified_at IS NULL)
      THEN NULL ELSE r.yield_percent::float8 END AS yield_percent,
 r.lot_size::float8 FROM public.articles a
 LEFT JOIN public.industrial_article_rules r ON r.article_id=a.id WHERE EXISTS(SELECT 1 FROM public.article_client_links x WHERE x.client_id=$1 AND x.article_id=a.id)
 OR EXISTS(SELECT 1 FROM public.commande_ligne l JOIN public.commande_client c ON c.id=l.commande_id WHERE l.article_id=a.id AND c.client_id=$1)
 ORDER BY a.code,a.id::text LIMIT 501`,
      [clientId],
    )
  ).rows;
  const contracts = (
    await db.query(
      `SELECT l.id AS contract_line_id,c.reference,l.configured_code,COALESCE(r.min_stock,0)::float8 AS min_stock,
 COALESCE(r.max_stock,0)::float8 AS max_stock,COALESCE(r.committed_forecast,false) AS committed_forecast,COALESCE(r.use_history,false) AS use_history,r.risk_limit_eur::float8
 FROM public.client_contract_lines l JOIN public.client_contracts c ON c.id=l.contract_id LEFT JOIN public.industrial_contract_rules r ON r.contract_line_id=l.id
 WHERE c.client_id=$1 AND c.status='ACTIVE' AND l.active ORDER BY c.reference,l.configured_code,l.id LIMIT 501`,
      [clientId],
    )
  ).rows;
  if (articles.length > 500 || contracts.length > 500)
    throw new HttpError(
      422,
      "PILOT_SETTINGS_LIMIT",
      "Périmètre pilote trop large.",
    );
  return { client_id: clientId, articles, contracts };
}
export async function updateIndustrialSettings(
  db: PoolClient,
  actor: number,
  body: z.infer<typeof industrialSettingsSchema>,
) {
  await readIndustrialPolicy(db, body.client_id, true);
  const current = await getIndustrialSettings(db, body.client_id);
  const ids = new Set(current.articles.map((a) => a.article_id)),
    lines = new Set(current.contracts.map((l) => l.contract_line_id));
  if (
    body.articles.some((a) => !ids.has(a.article_id)) ||
    body.contracts.some((l) => !lines.has(l.contract_line_id))
  )
    throw new HttpError(
      422,
      "PILOT_SETTINGS_SCOPE",
      "Article ou contrat hors du périmètre du pilote.",
    );
  for (const a of body.articles)
    await db.query(
      `INSERT INTO public.industrial_article_rules(article_id,family,lead_days,unit_cost_eur,yield_percent,lot_size,yield_qualified_at)
 VALUES($1,$2,$3,$4,COALESCE($5::numeric,100),$6,CASE WHEN $5::numeric IS NULL THEN NULL ELSE now() END)
 ON CONFLICT(article_id) DO UPDATE SET family=excluded.family,lead_days=excluded.lead_days,unit_cost_eur=excluded.unit_cost_eur,
 yield_percent=CASE WHEN $5::numeric IS NULL THEN industrial_article_rules.yield_percent ELSE excluded.yield_percent END,
 yield_qualified_at=CASE WHEN $5::numeric IS NULL THEN industrial_article_rules.yield_qualified_at ELSE excluded.yield_qualified_at END,
 lot_size=excluded.lot_size`,
      [
        a.article_id,
        a.family,
        a.lead_days,
        a.unit_cost_eur,
        a.yield_percent,
        a.lot_size,
      ],
    );
  for (const r of body.contracts)
    await db.query(
      `INSERT INTO public.industrial_contract_rules(contract_line_id,min_stock,max_stock,committed_forecast,risk_limit_eur,use_history)
 VALUES($1,$2,$3,$4,$5,COALESCE($6,false)) ON CONFLICT(contract_line_id) DO UPDATE SET min_stock=excluded.min_stock,max_stock=excluded.max_stock,
 committed_forecast=excluded.committed_forecast,risk_limit_eur=excluded.risk_limit_eur,use_history=COALESCE($6,industrial_contract_rules.use_history)`,
      [
        r.contract_line_id,
        r.min_stock,
        r.max_stock,
        r.committed_forecast,
        r.risk_limit_eur,
        r.use_history ?? null,
      ],
    );
  await db.query(
    "INSERT INTO public.industrial_policy_events(client_id,actor_id,snapshot) VALUES($1,$2,$3)",
    [
      body.client_id,
      actor,
      JSON.stringify({ previous: current, requested: body }),
    ],
  );
  return getIndustrialSettings(db, body.client_id);
}
