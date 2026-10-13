import { describe, expect, it } from 'vitest';
import { servicePurchasePreparations, type ServicePreparationSource } from './subcontract-preparation.domain';

const source = (): ServicePreparationSource => ({
    of: { id: 1, quantity: 110, hash: 'frozen', technicalVersion: 'version', ofRevisionId: 'revision' },
    hasDirectMaterial: true,
    purchases: ['coat', 'polish'].map(id => ({ id, article_id: id, designation: id, gamme_operation_id: 'source-op' })),
    operations: [{ id: 'op', sourceId: 'source-op', label: 'Traitements', returnDue: '2026-11-20' }],
    origins: [{ id: 'lot', label: 'MP-1' }],
    offers: ['coat', 'polish'].map(id => ({ id, articleId: id, supplierId: 'supplier', price: 2, unit: 'U', delay: 3 })),
    drafts: [{ purchaseId: 'coat', operationId: 'op', quantity: 100, orderId: 'order1', code: 'CF1' },
        { purchaseId: 'polish', operationId: 'op', quantity: 110, orderId: 'order2', code: 'CF2' }],
    predecessorState: [{ operationId: 'op', predecessors: [{ status: 'DONE', good: 110 }] }],
});
const selections = ['coat', 'polish'].map(purchaseId => ({ purchaseId, operationId: 'op', catalogueId: purchaseId, destinationId: null, due: null }));

describe('independent purchasing needs for services on one phase', () => {
    it('prepares only the missing ten pieces of coating and keeps polishing covered', () => {
        const [coat, polish] = servicePurchasePreparations(source(), selections);
        expect(coat).toMatchObject({ missing: 10, ordered: 10, service: { existingQuantity: 100, realQuantity: 110 },
            futurePurchases: [{ id: 'order1', available: 100 }] });
        expect(polish).toMatchObject({ missing: 0, service: { existingQuantity: 110 }, futurePurchases: [{ id: 'order2', available: 110 }] });
    });
    it('does not propose a quantity from an unidentified historical order', () => {
        const value = source(); value.drafts[0].purchaseId = null;
        const result = servicePurchasePreparations(value, selections);
        expect(result.every(p => p.missing === null && p.ordered === null && p.actions.some(a => a.includes('historiques')))).toBe(true);
    });
    it('preserves forecasting while real predecessor quantities are still open', () => {
        const value = source(); value.predecessorState[0].predecessors[0].status = 'RUNNING';
        expect(servicePurchasePreparations(value, selections)[0]).toMatchObject({ missing: null, service: { forecastQuantity: 110, realQuantity: null, existingQuantity: 100 } });
    });
});
