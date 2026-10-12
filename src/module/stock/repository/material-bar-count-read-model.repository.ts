import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;
type Line = { article_id: string; stock_batch_id: string | null };

/** Bulk metadata only: do not leak theoretical lengths into blind-count rows.
 * Whether a physical count is mandatory is decided from canonical stock data. */
export async function readMaterialBarCountRequirementsTx(
  tx: Db,
  lines: Line[],
) {
  const result = new Map<
    string,
    { unit_code: string; material_bar_count_required: boolean }
  >();
  if (!lines.length) return result;
  const articles = (
    await tx.query<{ id: string; unit: string; required: boolean }>(
      `
    SELECT a.id::text,lower(trim(a.unite)) AS unit,COALESCE(am.barre_a_decouper,false) AS required
    FROM public.articles a LEFT JOIN public.articles_matiere am ON am.article_id=a.id
    WHERE a.id=ANY($1::uuid[])`,
      [[...new Set(lines.map((line) => line.article_id))]],
    )
  ).rows;
  const installed = (
    await tx.query<{ installed: boolean }>(
      "SELECT to_regclass('public.stock_material_bar_inventories') IS NOT NULL AS installed",
    )
  ).rows[0]?.installed;
  const batches = [
    ...new Set(
      lines.flatMap((line) =>
        line.stock_batch_id ? [line.stock_batch_id] : [],
      ),
    ),
  ];
  const tracked = new Set(
    installed && batches.length
      ? (
          await tx.query<{ id: string }>(
            "SELECT stock_batch_id::text AS id FROM public.stock_material_bar_inventories WHERE stock_batch_id=ANY($1::uuid[])",
            [batches],
          )
        ).rows.map((row) => row.id)
      : [],
  );
  const byArticle = new Map(articles.map((article) => [article.id, article]));
  for (const line of lines) {
    const article = byArticle.get(line.article_id);
    if (article)
      result.set(`${line.article_id}:${line.stock_batch_id ?? ""}`, {
        unit_code: article.unit,
        material_bar_count_required:
          article.unit === "mm" &&
          (article.required || tracked.has(line.stock_batch_id ?? "")),
      });
  }
  return result;
}
