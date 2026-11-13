import { describe, expect, it } from 'vitest';
import { resolveReceiptOrderTransport } from './receipt-order-transport';
import { resolveReceiptAcquisitionValue, type ReceiptAcquisitionFacts } from './receipt-acquisition-value';

const id = '0491c5c8-8500-4d88-a94f-177054c6677c', other = '1491c5c8-8500-4d88-a94f-177054c6677c';
const articleId = '985c0e4c-ec2e-4a55-bb21-64d6beea5a96';
const line = { line_id: id, article_id: articleId, unit: 'm', quantity: '9', unit_price: '10', discount_percent: '10', additional_fees: '10' };
const source = { schema_version: 1, method: 'PROPORTIONAL_NET_V1', order_id: id, supplier_id: id, currency: 'EUR',
  transport_fees: '1', active_line_count: 2, lines_complete: true,
  lines: [line, { ...line, line_id: other, unit: 'kg', quantity: '91', unit_price: '1', discount_percent: '0', additional_fees: '0' }] };
const order = { id, lineId: id, articleId, status: 'ACCUSE_RECU', lineStatus: 'ACTIVE', unit: 'm', currency: 'EUR',
  quantity: '9', unitPrice: '10', discountPercent: '10', additionalFees: '10', transportFees: '1', supplierId: id, transportBasis: source };

describe('Material order transport — prepared common acceptance', () => {
  it('weights different units by discounted net plus line flat fees and preserves the total', () => {
    expect(resolveReceiptOrderTransport(order).amount).toBe('0.5');
    expect(resolveReceiptOrderTransport({ ...order, lineId: other, unit: 'kg', quantity: '91', unitPrice: '1', discountPercent: '0', additionalFees: '0' }).amount).toBe('0.5');
  });
  it('normalizes decimal formatting and line ordering but changes the hash with monetary facts', () => {
    const initial = resolveReceiptOrderTransport(order);
    expect(resolveReceiptOrderTransport({ ...order, transportBasis: { ...source, lines: [source.lines[1], { ...line, quantity: '9.000000', unit_price: '10.00' }] } }).sourceSha256).toBe(initial.sourceSha256);
    expect(resolveReceiptOrderTransport({ ...order, transportBasis: { ...source, lines: [line, { ...source.lines[1], unit_price: '2' }] } }).sourceSha256).not.toBe(initial.sourceSha256);
  });
  it('keeps old, incomplete, duplicate, cross-order and mismatched line bases unknown', () => {
    for (const transportBasis of [undefined, { ...source, lines_complete: false }, { ...source, order_id: other },
      { ...source, active_line_count: 3 }, { ...source, lines: [line, line] }, { ...source, lines: [{ ...line, quantity: '8' }, source.lines[1]] }]) {
      expect(resolveReceiptOrderTransport({ ...order, transportBasis }).amount).toBeNull();
    }
    expect(resolveReceiptOrderTransport({ ...order, transportFees: null }).amount).toBeNull();
    expect(resolveReceiptOrderTransport({ ...order, transportFees: '0', transportBasis: undefined }).amount).toBe('0');
  });
  it('uses cumulative capped residuals for both transport and flat fees, including overreceipt', () => {
    const single = { ...order, quantity: '3', unitPrice: '1', discountPercent: '0', additionalFees: '1',
      transportBasis: { ...source, active_line_count: 1, lines: [{ ...line, quantity: '3', unit_price: '1', discount_percent: '0', additional_fees: '1' }] } };
    const facts: ReceiptAcquisitionFacts = { sourceRef: 'stock-acquisition:' + id, articleId, ownerClientId: null,
      stockQuantity: '1000', stockUnit: 'mm', receiptQuantity: '1', receiptUnit: 'm', conversionCoefficient: '1000', order: single };
    const values = ['0', '1', '2', '3'].map(beforeQuantity => resolveReceiptAcquisitionValue(facts, 'EUR', { orderLineId: id, beforeQuantity, sourceRef: 'locked-cursor' }));
    expect(values.map(v => v.transportAmount)).toEqual(['0.333333333333', '0.333333333334', '0.333333333333', '0']);
    expect(values.map(v => v.feesAmount)).toEqual(values.map(v => v.transportAmount));
    expect(resolveReceiptAcquisitionValue(facts, 'EUR').amount).toBeNull();
  });
});
