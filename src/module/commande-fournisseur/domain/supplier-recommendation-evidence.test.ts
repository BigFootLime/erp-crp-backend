import { describe, expect, it } from 'vitest';
import { rankSupplierSuggestions, type SupplierSuggestion } from './supplier-recommendation';
import { supplierRecommendationEvidence, type SourcedSupplierSuggestion } from './supplier-recommendation-evidence';

const item: SourcedSupplierSuggestion = {
  supplier_id: '00000000-0000-4000-8000-000000000001', supplier_name: 'Fournisseur de recette',
  sent_orders: 5, received_orders: 3, last_order_id: '00000000-0000-4000-8000-000000000002',
  last_order_code: 'RECETTE', last_order_at: '2026-10-01T08:00:00Z', actual_days: 3,
  can_engage: true, qualification_known: true, review_outcome: 'SATISFACTORY', review_ids: [], quality_score: 5,
  catalogue_id: null, estimated_ht: null, purchase_quantity: null, purchase_unit: null, currency: 'EUR',
  announced_days: null, score: 0, confidence: 'HIGH', reasons: ['5 commandes envoyées'], warnings: [],
  sources: { order: null, catalogue: null, reviews: [] },
};
const context = { of_id: 1, of_updated_at: '2026-10-08T08:00:00Z', technical_version_id: null,
  article_id: '00000000-0000-4000-8000-000000000003', quantity: 30, unit: 'mm', currency: 'EUR' };

describe('preuves des recommandations — recette commune préparée, non exécutée', () => {
  it('change l’empreinte si la quantité, la version OF ou une source d’évaluation change', () => {
    const original = supplierRecommendationEvidence(context, [item], false, false).source_sha256;
    expect(supplierRecommendationEvidence({ ...context, quantity: 31 }, [item], false, false).source_sha256).not.toBe(original);
    expect(supplierRecommendationEvidence({ ...context, of_updated_at: '2026-10-08T09:00:00Z' }, [item], false, false).source_sha256).not.toBe(original);
    expect(supplierRecommendationEvidence(context, [{ ...item, sources: { ...item.sources,
      reviews: [{ id: 'review', evaluated_on: '2026-10-08', outcome: 'RESERVATIONS', quality_score: 3, domain: null }] } }], false, false).source_sha256).not.toBe(original);
  });
  it('ne dépend pas de l’ordre de retour des preuves d’évaluation', () => {
    const reviews = ['b', 'a'].map(id => ({ id, evaluated_on: '2026-10-08', outcome: 'SATISFACTORY', quality_score: 5, domain: null }));
    const evidence = (rows: typeof reviews) => supplierRecommendationEvidence(context,
      [{ ...item, sources: { ...item.sources, reviews: rows } }], false, false).source_sha256;
    expect(evidence(reviews)).toBe(evidence([...reviews].reverse()));
  });
  it('n’utilise pas le prix dans le score du lecteur sans droit de prix', () => {
    const ranked = rankSupplierSuggestions([{ ...item, estimated_ht: 100 }], false)[0];
    expect(ranked.ranking?.price).toEqual({ available: false, weight: 0, points: 0 });
    expect(supplierRecommendationEvidence(context, [item], false, false).policy.weights.price).toBe(0);
    expect(ranked.score).toBe(100);
  });
  it('classe un fournisseur qualifié avant un score plus haut bloqué', () => {
    const blocked: SupplierSuggestion = { ...item, supplier_id: 'blocked', can_engage: false, estimated_ht: 1, sent_orders: 100 };
    const ranked = rankSupplierSuggestions([blocked, { ...item, sent_orders: 1, received_orders: 0, actual_days: null, quality_score: null }], true);
    expect(ranked[0].supplier_id).toBe(item.supplier_id);
    expect(ranked[0].ranking?.delay.available).toBe(false);
    expect(ranked[0].ranking?.price.available).toBe(false);
  });
});
