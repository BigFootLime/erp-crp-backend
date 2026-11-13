import type { PoolClient } from "pg";

import { canonicalizeStockUnitCode } from "./stock-unit";

type UnitQueryClient = Pick<PoolClient, "query">;

export type ArticleStockUnitPolicy = Readonly<{
  articleLookupLimit?: 1;
  missingUnit:
    | Readonly<{ defaultCode: string }>
    | Readonly<{ error: () => Error }>;
  unknownUnitError: (code: Readonly<{ submitted: string; canonical: string }>) => Error;
}>;

/**
 * `public.units.code` is the single stock-unit referential. Articles retain
 * their unit as a code so every creation/update must check that code before it
 * can later be used by a stock movement.
 */
export async function findCanonicalStockUnit(
  client: UnitQueryClient,
  unitCode: string | null | undefined
): Promise<{ id: string | null; code: string } | null> {
  const code = canonicalizeStockUnitCode(unitCode);
  if (!code) return null;
  const unit = await client.query<{ id: string | null }>(
    `SELECT id::text AS id FROM public.units WHERE lower(code::text) = lower($1) LIMIT 1`,
    [code]
  );
  const row = unit.rows[0];
  return row ? { id: row.id, code } : null;
}

/** Resolve within the caller's transaction; missing/unknown-unit decisions remain caller-owned. */
export async function resolveArticleStockUnit(
  client: UnitQueryClient,
  articleId: string,
  preferredUnitCode: string | null | undefined,
  policy: ArticleStockUnitPolicy
): Promise<{ unit_id: string; unit_code: string }> {
  let submitted = preferredUnitCode?.trim() ? preferredUnitCode.trim() : null;
  if (!submitted) {
    const article = await client.query<{ unite: string | null }>(
      policy.articleLookupLimit === 1
        ? `SELECT unite FROM public.articles WHERE id = $1::uuid LIMIT 1`
        : `SELECT unite FROM public.articles WHERE id = $1::uuid`,
      [articleId]
    );
    submitted = article.rows[0]?.unite?.trim() ? article.rows[0].unite.trim() : null;
  }

  let code = canonicalizeStockUnitCode(submitted);
  if (!code) {
    if ("error" in policy.missingUnit) throw policy.missingUnit.error();
    code = policy.missingUnit.defaultCode;
    submitted = code;
  }

  const unit = await findCanonicalStockUnit(client, code);
  if (!unit?.id) throw policy.unknownUnitError({ submitted: submitted ?? code, canonical: code });
  return { unit_id: unit.id, unit_code: code };
}
