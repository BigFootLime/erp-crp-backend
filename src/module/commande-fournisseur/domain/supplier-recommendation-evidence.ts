import { createHash } from 'node:crypto';
import { SUPPLIER_RECOMMENDATION_POLICY, type SupplierSuggestion } from './supplier-recommendation';

export type SupplierRecommendationContext = {
  of_id: number; of_updated_at: string; technical_version_id: string | null;
  article_id: string; quantity: number | null; unit: string | null; currency: string;
};
export type SupplierRecommendationSources = {
  order: { id: string; code: string | null; sent_at: string | null } | null;
  catalogue: { id: string; version: string; comparable_price: boolean } | null;
  reviews: Array<{ id: string; evaluated_on: string; outcome: string; quality_score: number | null; domain: string | null }>;
};
export type SourcedSupplierSuggestion = SupplierSuggestion & { sources: SupplierRecommendationSources };

/** This fingerprint describes the displayed evidence, not a purchasing intent.
 * It contains no observation clock, hidden prices, or executable instruction. */
export function supplierRecommendationEvidence(context: SupplierRecommendationContext,
  items: SourcedSupplierSuggestion[], canReadPrices: boolean, truncated: boolean) {
  const policy = { id: SUPPLIER_RECOMMENDATION_POLICY, mode: 'ERP_DATA' as const, history_months: 24,
    weights: { price: canReadPrices ? 40 : 0, history: 30, delay: 15, quality: 15 },
    requires_confirmation: true as const, score_is_confidence: false as const,
    priority: ['QUALIFICATION', 'QUALITY_REVIEW', 'QUALIFICATION_KNOWN', 'RANKING'] };
  const evidence = items.map(item => ({
    supplier_id: item.supplier_id, supplier_name: item.supplier_name, sent_orders: item.sent_orders,
    received_orders: item.received_orders, actual_days: item.actual_days, can_engage: item.can_engage,
    qualification_known: item.qualification_known, review_outcome: item.review_outcome,
    quality_score: item.quality_score, catalogue_id: item.catalogue_id, estimated_ht: item.estimated_ht,
    purchase_quantity: item.purchase_quantity, purchase_unit: item.purchase_unit, currency: item.currency,
    announced_days: item.announced_days, ranking: item.ranking, score: item.score, confidence: item.confidence,
    reasons: item.reasons, warnings: item.warnings, sources: { ...item.sources,
      reviews: [...item.sources.reviews].sort((a, b) => a.id.localeCompare(b.id)) },
  }));
  const source_sha256 = createHash('sha256').update(JSON.stringify({ context, policy, can_read_prices: canReadPrices,
    truncated, items: evidence })).digest('hex');
  return { context, policy, source_sha256 };
}
