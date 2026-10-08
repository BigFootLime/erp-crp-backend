import { priceCatalogueLine, type CataloguePriceSnapshot } from './catalogue-line-pricing';
import type { PurchaseQualification } from '../../fournisseurs/domain/purchase-qualification';
import { ZodError } from 'zod';
import { HttpError } from '../../../utils/httpError';

export type SupplierHistory = {
  supplier_id: string; supplier_name: string; sent_orders: number; received_orders: number;
  last_order_id: string | null; last_order_code: string | null; last_order_at: string | null;
  actual_days: number | null;
};
export type RecommendationCatalogue = CataloguePriceSnapshot & {
  supplier_id: string; stock_unit: string | null; coefficient: number | null; pack: number | null;
  pricing_basis: string | null; price_multiple: number | null; delay_days: number | null; type: string;
};
export type SupplierReview = {
  supplier_id: string; domain: string | null; id: string; evaluated_on: string;
  outcome: string; quality_score: number | null;
};
export type SupplierSuggestion = SupplierHistory & {
  can_engage: boolean; qualification_known: boolean; review_outcome: string | null;
  review_ids: string[]; quality_score: number | null;
  catalogue_id: string | null; estimated_ht: number | null; purchase_quantity: number | null;
  purchase_unit: string | null; currency: string; announced_days: number | null;
  score: number; confidence: 'LOW' | 'MEDIUM' | 'HIGH'; reasons: string[]; warnings: string[];
  ranking?: SupplierRanking;
};

export type SupplierRankingCriterion = { available: boolean; weight: number; points: number };
export type SupplierRanking = {
  price: SupplierRankingCriterion; history: SupplierRankingCriterion;
  delay: SupplierRankingCriterion; quality: SupplierRankingCriterion;
};

export const SUPPLIER_RECOMMENDATION_POLICY = 'supplier-history-v2' as const;

/** Estimate the same catalogue line as the purchase writer. No FX, inferred
 * conversion, old purchase price, or missing tariff is used for comparison. */
export function estimateRecommendationPrice(catalogue: RecommendationCatalogue, quantity: number | undefined,
  unit: string | undefined, currency: string) {
  if (!quantity || !unit || !catalogue.unit || catalogue.currency !== currency ||
    (catalogue.price_multiple ?? 1) !== 1 ||
    (catalogue.pricing_basis && catalogue.pricing_basis !== 'NONE' && catalogue.pricing_basis.toLowerCase() !== catalogue.unit.toLowerCase())) return null;
  const coefficient = catalogue.coefficient ?? (catalogue.unit === unit ? 1 : null);
  if (!coefficient || !Number.isFinite(coefficient) || coefficient <= 0 || (catalogue.stock_unit ?? catalogue.unit) !== unit ||
    [catalogue.moq, catalogue.forfait_ht, catalogue.minimum_facturation_ht].some(value => value !== null && (!Number.isFinite(value) || value < 0)) ||
    (catalogue.pack !== null && (!Number.isFinite(catalogue.pack) || catalogue.pack <= 0))) return null;
  const minimum = Math.max(quantity / coefficient, catalogue.moq ?? 0);
  const purchaseQuantity = catalogue.pack ? Math.ceil((minimum - 1e-9) / catalogue.pack) * catalogue.pack : Math.ceil((minimum - 1e-9) * 1000) / 1000;
  try {
    return { total: priceCatalogueLine(catalogue, purchaseQuantity).net_ht, quantity: purchaseQuantity };
  } catch (error) {
    if (!(error instanceof HttpError) && !(error instanceof ZodError)) throw error;
    // Incomplete or inconsistent catalogue rows remain selectable manually,
    // but never acquire an invented price or a price-based recommendation.
    return null;
  }
}

export function rankSupplierSuggestions(items: SupplierSuggestion[], comparePrices: boolean): SupplierSuggestion[] {
  const eligible = items.filter(item => item.can_engage && item.review_outcome !== 'UNSATISFACTORY');
  const costs = eligible.flatMap(item => item.estimated_ht === null ? [] : [item.estimated_ht]);
  const delays = eligible.flatMap(item => item.actual_days === null ? [] : [item.actual_days]);
  const minimumCost = costs.length ? Math.min(...costs) : null;
  const minimumDelay = delays.length ? Math.min(...delays) : null;
  const maximumOrders = Math.max(1, ...eligible.map(item => item.sent_orders));
  const weight = comparePrices ? 100 : 60;
  const criterion = (available: boolean, criterionWeight: number, ratio: number): SupplierRankingCriterion =>
    ({ available, weight: criterionWeight, points: available ? Number((100 * criterionWeight * ratio / weight).toFixed(6)) : 0 });
  return items.map(item => {
    const ranking: SupplierRanking = {
      price: criterion(comparePrices && item.estimated_ht !== null && minimumCost !== null, comparePrices ? 40 : 0,
        item.estimated_ht !== null && minimumCost !== null ? (minimumCost + 1) / (item.estimated_ht + 1) : 0),
      history: criterion(item.sent_orders > 0, 30, Math.log1p(item.sent_orders) / Math.log1p(maximumOrders)),
      delay: criterion(item.actual_days !== null && minimumDelay !== null, 15,
        item.actual_days !== null && minimumDelay !== null ? (minimumDelay + 1) / (item.actual_days + 1) : 0),
      quality: criterion(item.quality_score !== null, 15, (item.quality_score ?? 0) / 5),
    };
    // Preserve the existing ranking exactly; rounded contributions are explanatory only.
    const score = Math.round(100 * (
      (comparePrices && item.estimated_ht !== null && minimumCost !== null ? 40 * (minimumCost + 1) / (item.estimated_ht + 1) : 0) +
      30 * Math.log1p(item.sent_orders) / Math.log1p(maximumOrders) +
      (item.actual_days !== null && minimumDelay !== null ? 15 * (minimumDelay + 1) / (item.actual_days + 1) : 0) +
      (item.quality_score !== null ? 15 * item.quality_score / 5 : 0)
    ) / weight);
    return { ...item, ranking, score };
  }).sort((a, b) =>
    Number(b.can_engage) - Number(a.can_engage) ||
    Number(a.review_outcome === 'UNSATISFACTORY') - Number(b.review_outcome === 'UNSATISFACTORY') ||
    Number(b.qualification_known) - Number(a.qualification_known) || b.score - a.score ||
    b.sent_orders - a.sent_orders || a.supplier_name.localeCompare(b.supplier_name, 'fr') || a.supplier_id.localeCompare(b.supplier_id));
}

export function summarizeSupplierQualification(state: PurchaseQualification) {
  const checks = [state.global, ...state.domains, ...(state.client_approvals ?? [])];
  return { can_engage: state.can_engage,
    known: state.unmapped_line_ids.length === 0 && checks.every(check => check.status === 'VALID' || check.status === 'NOT_REQUIRED') };
}
