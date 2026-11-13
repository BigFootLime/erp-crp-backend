import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import { readIndustrialPolicy } from "../../planning/repository/industrial-policy.repository";
export type ArticleMapping = {
  client_id: string;
  external_code: string;
  external_unit: string;
  article_id: string;
  units_per_external: number;
};
export async function saveArticleMapping(
  tx: PoolClient,
  m: ArticleMapping,
  actor: number,
) {
  await readIndustrialPolicy(tx, m.client_id, true);
  const eligible = await tx.query(
    `SELECT 1 FROM public.article_client_links x JOIN public.articles a ON a.id=x.article_id
   WHERE x.client_id=$1 AND x.article_id=$2 AND a.status='VALIDE' AND a.archived_at IS NULL AND a.is_active AND a.unite IS NOT NULL FOR SHARE`,
    [m.client_id, m.article_id],
  );
  if (!eligible.rowCount)
    throw new HttpError(
      422,
      "ARTICLE_MAPPING_SCOPE",
      "Article validé non rattaché à ce client.",
    );
  const old =
    (
      await tx.query(
        "SELECT * FROM public.demand_pilot_article_mappings WHERE client_id=$1 AND external_code=$2 AND external_unit=$3 FOR UPDATE",
        [m.client_id, m.external_code, m.external_unit.toUpperCase()],
      )
    ).rows[0] ?? null;
  const saved = (
    await tx.query(
      `INSERT INTO public.demand_pilot_article_mappings(client_id,external_code,external_unit,article_id,units_per_external,actor_id)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(client_id,external_code,external_unit) DO UPDATE SET article_id=excluded.article_id,
 units_per_external=excluded.units_per_external,actor_id=excluded.actor_id,updated_at=now() RETURNING *`,
      [
        m.client_id,
        m.external_code,
        m.external_unit.toUpperCase(),
        m.article_id,
        m.units_per_external,
        actor,
      ],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO public.industrial_policy_events(client_id,actor_id,snapshot) VALUES($1,$2,$3)",
    [m.client_id, actor, JSON.stringify({ before: old, after: saved })],
  );
  return saved;
}
