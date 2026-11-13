import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { formatCumpDecimal, parseCumpDecimal } from '../../stock/domain/cump-decimal';
import { readContractArticleOptions } from './client-contract.repository';
import type { ClientContractArticle } from '../types/client-contract.types';
import type { ContractCoverageDemand, CoveragePeriod } from '../types/client-contract-coverage.types';

type Queryer = Pick<PoolClient, 'query'>;
type PromisePart = { id: string; quantity: string; due_date: string };
type FirmAllocation = { id: string; quantity: string; delivered: string; due_date: string | null; parts: PromisePart[] };
export type FirmCoverageRow = {
  id: string; article_id: string; unit: string; quantity: string; delivered: string;
  due_date: string | null; contract_id: string | null; contract_line_id: string | null;
  allocations: FirmAllocation[]; legacy_shipment: boolean;
};
type ForecastRow = { id: string; client_id: string; contract_id: string; contract_line_id: string;
  root_article_id: string; unit_id: string; quantity: string; month: string; due_date: string; target_date: string };

export const CONTRACT_COVERAGE_PERIODS_SQL = `SELECT to_char(month,'YYYY-MM') AS month,
  (month-INTERVAL '1 day')::date::text AS target_date,
  (month+INTERVAL '1 month'-INTERVAL '1 day')::date::text AS end_date
  FROM generate_series($1::date,$1::date+($2::int-1)*INTERVAL '1 month',INTERVAL '1 month') month`;

export const CONTRACT_COVERAGE_FORECASTS_SQL = `SELECT f.id::text,c.client_id,f.contract_id::text,f.contract_line_id::text,
  f.root_article_id::text,f.unit_id::text,coverage.remaining_quantity::text AS quantity,
  to_char(f.month,'YYYY-MM') AS month,f.delivery_due::text AS due_date,
  (f.month-INTERVAL '1 day')::date::text AS target_date
  FROM public.client_contract_forecasts f JOIN public.client_contracts c ON c.id=f.contract_id
  JOIN public.client_contract_lines line ON line.id=f.contract_line_id AND line.active
  JOIN public.v_client_contract_forecast_coverage coverage ON coverage.forecast_id=f.id
  WHERE c.status='ACTIVE' AND f.status='ACTIVE' AND coverage.remaining_quantity>0
    AND f.root_article_id=ANY($1::uuid[]) AND f.month<=$2::date
  ORDER BY f.month,f.id LIMIT 2001`;

export const CONTRACT_COVERAGE_FIRM_SQL = `SELECT line.id::text,line.article_id::text,
  upper(btrim(COALESCE(line.unite,article.unite))) AS unit,line.quantite::text AS quantity,
  line.delai_client::date::text AS due_date,COALESCE(binding.contract_id,legacy.contract_id)::text AS contract_id,
  COALESCE(binding.contract_line_id,legacy.contract_line_id)::text AS contract_line_id,
  COALESCE((SELECT sum(a.quantite) FROM public.bon_livraison_ligne_allocations a
    JOIN public.bon_livraison_ligne bl_line ON bl_line.id=a.bon_livraison_ligne_id
    JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
    LEFT JOIN public.commande_ligne_affaire_allocation source ON source.id=a.commande_ligne_affaire_allocation_id
    LEFT JOIN public.stock_reservations reservation ON reservation.id=a.reservation_id
    WHERE COALESCE(source.commande_ligne_id,reservation.commande_ligne_id,bl_line.commande_ligne_id)=line.id
      AND bl.statut IN ('SHIPPED','DELIVERED')),0)::text AS delivered,
  EXISTS(SELECT 1 FROM public.bon_livraison_ligne bl_line JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
    WHERE bl_line.commande_ligne_id=line.id AND bl.statut IN ('SHIPPED','DELIVERED') AND
      NOT EXISTS(SELECT 1 FROM public.bon_livraison_ligne_allocations a WHERE a.bon_livraison_ligne_id=bl_line.id)) AS legacy_shipment,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id::text,'quantity',a.qty_ordered::text,
    'delivered',a.qty_delivered::text,'due_date',COALESCE(promise.due_date,line.delai_client)::date::text,
    'parts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id::text,
      'quantity',(p.quantity-COALESCE((SELECT sum(s.quantity) FROM public.delivery_promise_shipments s WHERE s.part_id=p.id),0))::text,
      'due_date',p.due_date::text) ORDER BY p.due_date,p.id)
      FROM public.delivery_promise_roots r JOIN public.delivery_promise_parts p ON p.root_id=r.id AND p.retired_at IS NULL
      WHERE r.allocation_id=a.id),'[]'::jsonb)) ORDER BY a.id)
    FROM public.commande_ligne_affaire_allocation a
    LEFT JOIN LATERAL (SELECT min(p.due_date) AS due_date FROM public.delivery_promise_roots r
      JOIN public.delivery_promise_parts p ON p.root_id=r.id AND p.retired_at IS NULL WHERE r.allocation_id=a.id) promise ON true
    WHERE a.commande_ligne_id=line.id),'[]'::jsonb) AS allocations
  FROM public.commande_ligne line JOIN public.commande_client commande ON commande.id=line.commande_id
  JOIN public.articles article ON article.id=line.article_id
  LEFT JOIN public.client_contract_call_lines binding ON binding.commande_ligne_id=line.id
  LEFT JOIN public.client_contract_legacy_lines legacy ON legacy.commande_ligne_id=line.id
  WHERE line.article_id=ANY($1::uuid[]) AND commande.order_type='FERME'
    AND COALESCE((SELECT h.nouveau_statut FROM public.commande_historique h WHERE h.commande_id=commande.id
      ORDER BY h.date_action DESC,h.id DESC LIMIT 1),'BROUILLON') NOT IN ('ANNULE','ARCHIVE') ORDER BY line.id LIMIT 2001`;

// A historical CADRE header is a framework quantity, not a firm call. Its old
// confirmed releases require their own shipment mapping before automatic MRP.
export const CONTRACT_COVERAGE_CADRE_REVIEW_SQL = `SELECT EXISTS(
  SELECT 1 FROM public.commande_ligne line JOIN public.commande_client commande ON commande.id=line.commande_id
  WHERE line.article_id=ANY($1::uuid[]) AND commande.order_type='CADRE'
  AND COALESCE((SELECT h.nouveau_statut FROM public.commande_historique h WHERE h.commande_id=commande.id
    ORDER BY h.date_action DESC,h.id DESC LIMIT 1),'BROUILLON') NOT IN ('ANNULE','ARCHIVE')
  AND COALESCE((SELECT sum(item.quantite) FROM public.commande_cadre_release_ligne item
    JOIN public.commande_cadre_release release ON release.id=item.release_id
    WHERE item.commande_ligne_id=line.id AND release.statut IN ('CONFIRMED','DELIVERED')),0)>
    COALESCE((SELECT sum(a.quantite) FROM public.bon_livraison_ligne_allocations a
      JOIN public.bon_livraison_ligne bl_line ON bl_line.id=a.bon_livraison_ligne_id
      JOIN public.bon_livraison bl ON bl.id=bl_line.bon_livraison_id
      LEFT JOIN public.commande_ligne_affaire_allocation source ON source.id=a.commande_ligne_affaire_allocation_id
      LEFT JOIN public.stock_reservations reservation ON reservation.id=a.reservation_id
      WHERE COALESCE(source.commande_ligne_id,reservation.commande_ligne_id,bl_line.commande_ligne_id)=line.id
        AND bl.statut IN ('SHIPPED','DELIVERED')),0)
) AS needs_review`;

function inconsistent(message: string): never {
  throw new HttpError(409, 'CONTRACT_COVERAGE_DELIVERY_REVIEW_REQUIRED', message);
}
function firmDemands(row: FirmCoverageRow, endDate: string): ContractCoverageDemand[] {
  if (row.legacy_shipment) inconsistent('Une livraison historique sans affectation de lot doit être rapprochée avant le calcul des besoins.');
  const ordered = parseCumpDecimal(row.quantity), delivered = parseCumpDecimal(row.delivered);
  if (delivered > ordered) inconsistent('Une quantité livrée dépasse la ligne commandée. Vérifiez les affectations de livraison.');
  const groups = row.allocations.length ? row.allocations : [{ id: '', quantity: row.quantity,
    delivered: row.delivered, due_date: row.due_date, parts: [] }];
  if (row.allocations.length && (groups.reduce((sum, item) => sum + parseCumpDecimal(item.quantity), 0n) !== ordered
    || groups.reduce((sum, item) => sum + parseCumpDecimal(item.delivered), 0n) !== delivered))
    inconsistent('Les quantités des affaires et des livraisons doivent être rapprochées avec la commande.');
  const result: ContractCoverageDemand[] = [];
  for (const group of groups) {
    const remaining = parseCumpDecimal(group.quantity) - parseCumpDecimal(group.delivered);
    if (remaining < 0n) inconsistent('Une affaire a reçu une quantité livrée supérieure à sa quantité commandée.');
    const parts = group.parts.length ? group.parts : [{ id: 'default', quantity: formatCumpDecimal(remaining), due_date: group.due_date! }];
    if (parts.some(part => parseCumpDecimal(part.quantity, true) < 0n)
      || parts.reduce((sum, part) => sum + parseCumpDecimal(part.quantity, true), 0n) !== remaining)
      inconsistent('Les parts de livraison ne correspondent plus au restant de leur affaire. Actualisez les engagements.');
    for (const part of parts) {
      if (!parseCumpDecimal(part.quantity)) continue;
      if (!part.due_date) inconsistent('Une ligne ferme restante nécessite son échéance de livraison avant le calcul des besoins.');
      if (part.due_date > endDate) continue;
      result.push({ id: `firm:${row.id}:${group.id}:${part.id}`, kind: 'FIRM', article_id: row.article_id,
        unit: row.unit, quantity: part.quantity, due_date: part.due_date, target_date: part.due_date,
        month: part.due_date.slice(0, 7), contract_id: row.contract_id, contract_line_id: row.contract_line_id,
        order_line_id: row.id, allocation_id: group.id || null });
    }
  }
  return result;
}

export async function readContractCoverageDemands(db: Queryer, articles: readonly ClientContractArticle[], periods: readonly CoveragePeriod[]) {
  const articleIds = articles.map(article => article.article_id);
  const legacy = (await db.query<{ needs_review: boolean }>(CONTRACT_COVERAGE_CADRE_REVIEW_SQL, [articleIds])).rows[0];
  if (legacy.needs_review) throw new HttpError(409, 'CONTRACT_COVERAGE_CADRE_REVIEW_REQUIRED',
    'Des appels confirmés d’un cadre historique nécessitent leur rapprochement de livraison avant le calcul automatique.');
  const roots = [...new Set(articles.map(article => article.root_article_id))];
  const forecasts = (await db.query<ForecastRow>(CONTRACT_COVERAGE_FORECASTS_SQL, [roots, periods.at(-1)!.end_date])).rows;
  const firm = (await db.query<FirmCoverageRow>(CONTRACT_COVERAGE_FIRM_SQL, [articleIds])).rows;
  if (forecasts.length > 2000 || firm.length > 2000) throw new HttpError(422, 'CONTRACT_COVERAGE_SCOPE_TOO_LARGE', 'Le calcul dépasse 2 000 lignes. Réduisez le périmètre avant de calculer.');
  const currentArticles = new Map<string, ClientContractArticle>();
  for (const clientId of [...new Set(forecasts.map(row => row.client_id))].sort()) {
    const proposed = await readContractArticleOptions(db, clientId, '', roots);
    for (const article of proposed) currentArticles.set(`${clientId}:${article.root_article_id}`, article);
  }
  const ids = new Set(articles.map(article => article.article_id));
  const demands = firm.flatMap(row => firmDemands(row, periods.at(-1)!.end_date));
  for (const row of forecasts) {
    const article = currentArticles.get(`${row.client_id}:${row.root_article_id}`);
    if (!article) throw new HttpError(409, 'CONTRACT_COVERAGE_ARTICLE_REQUIRED', 'Un article prévu doit avoir une définition technique applicable et validée.');
    if (!ids.has(article.article_id)) continue;
    if (article.unit_id !== row.unit_id) throw new HttpError(409, 'CONTRACT_COVERAGE_UNIT_CHANGED', 'L’unité d’une estimation ne correspond plus à son article.');
    demands.push({ id: `forecast:${row.id}`, kind: 'FORECAST', article_id: article.article_id, unit: article.unit,
      contract_id: row.contract_id, contract_line_id: row.contract_line_id, order_line_id: null, allocation_id: null,
      quantity: row.quantity, due_date: row.due_date, month: row.month, target_date: row.target_date });
  }
  if (demands.length > 5000) throw new HttpError(422, 'CONTRACT_COVERAGE_SCOPE_TOO_LARGE', 'Le calcul dépasse 5 000 parts de livraison. Aucune synthèse partielle n’a été produite.');
  return { demands, firm };
}
