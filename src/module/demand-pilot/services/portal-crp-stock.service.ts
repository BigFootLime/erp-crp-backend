import { HttpError } from "../../../utils/httpError";
import { readContractCoverageStock } from "../../client/repository/client-contract-coverage-stock.repository";
import { industrialTx } from "../../planning/services/industrial-runs.service";
import { formatCumpDecimal, parseCumpDecimal } from "../../stock/domain/cump-decimal";
import type { DemandRow } from "../types/demand-pilot.types";

export type PortalCrpStock = { quantity: string; unit: string };

/** Only release free CRP-owned stock of valid, customer-exclusive manufactured references. */
export async function readPortalCrpStock(
  clientId: string,
  rows: ReadonlyArray<Pick<DemandRow, "article_id">>,
) {
  const result = new Map<string, PortalCrpStock>();
  const ids = [...new Set(rows.flatMap(row => row.article_id ? [row.article_id] : []))];
  if (!ids.length) return result;
  return industrialTx(async tx => {
    const articles = (await tx.query<{ id: string; unit: string }>(
      `SELECT a.id, upper(btrim(a.unite)) AS unit FROM public.articles a
       WHERE a.id=ANY($1::uuid[]) AND a.archived_at IS NULL AND a.status='VALIDE'
         AND a.commercial_scope='CLIENTS' AND a.article_category='fabrique' AND a.stock_managed
         AND EXISTS (
           SELECT 1 FROM public.article_client_links s
           WHERE s.article_id=a.id AND s.client_id=$2
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.articles v JOIN public.article_client_links s ON s.article_id=v.id
           WHERE coalesce(v.root_article_id,v.id)=coalesce(a.root_article_id,a.id) AND s.client_id<>$2
         )`,
      [ids, clientId],
    )).rows;
    if (!articles.length) return result;

    // The domain calculation bounds positions, lots and reservations. Omit the
    // optional figure when it cannot calculate the entire requested scope.
    const coverage = await readContractCoverageStock(tx, articles.map(article => article.id))
      .catch(error => {
        if (error instanceof HttpError && error.status === 422) return null;
        throw error;
      });
    if (!coverage) return result;
    const free = coverage.sources.filter(source => source.kind === "FREE");
    const ownership = (await tx.query<{ id: string }>(
      "SELECT id FROM public.lots WHERE id=ANY($1::uuid[]) AND client_proprietaire_id IS NULL",
      [free.map(source => source.reference_id)],
    )).rows;
    const crpLots = new Set(ownership.map(lot => lot.id));
    for (const article of articles) {
      const quantity = free
        .filter(source => source.article_id === article.id && source.unit === article.unit && crpLots.has(source.reference_id))
        .reduce((total, source) => total + parseCumpDecimal(source.quantity), 0n);
      result.set(article.id, { quantity: formatCumpDecimal(quantity), unit: article.unit });
    }
    return result;
  }, "REPEATABLE READ");
}
