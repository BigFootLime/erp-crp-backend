import { describe, expect, it } from 'vitest';
import { resolveReceiptAcquisitionValue, type ReceiptAcquisitionFacts } from './receipt-acquisition-value';
import { resolveCapturedReceiptAcquisitionValue } from './receipt-acquisition-snapshot';

const articleId = '985c0e4c-ec2e-4a55-bb21-64d6beea5a96';
const id = '0491c5c8-8500-4d88-a94f-177054c6677c';
const facts: ReceiptAcquisitionFacts = { sourceRef: `stock-acquisition:${id}`,articleId,ownerClientId: null,
  stockQuantity: '3000',stockUnit: 'mm',receiptQuantity: '3',receiptUnit: 'm',conversionCoefficient: '1000',
  order: { id,lineId: id,articleId,status: 'ACCUSE_RECU',lineStatus: 'ACTIVE',unit: 'm',currency: 'EUR',
    quantity: '9',unitPrice: '10',discountPercent: '10',additionalFees: '0',transportFees: '0' } };
const resolve = (change: Partial<ReceiptAcquisitionFacts> = {}) => resolveReceiptAcquisitionValue({ ...facts,...change },'EUR');

describe('Acquisition CUMP — preuves de réception figées', () => {
  it('valorise la quantité reçue avec remise et conversion, jamais la quantité commandée', () => {
    expect(resolve()).toMatchObject({ amount: '27',unitCost: '0.009',reliability: 'DECLARED',priceAmount: '27',feesAmount: '0' });
  });
  it('ne répète pas un forfait sur chaque réception partielle et conserve le reliquat exact', () => {
    const order = { ...facts.order!,additionalFees: '1' };
    const values = ['0','3','6','9'].map(beforeQuantity => resolveReceiptAcquisitionValue({ ...facts,order },'EUR',
      { orderLineId: id,beforeQuantity,sourceRef: 'stock-allocation-cursor:locked' }));
    expect(values.map(v => v.feesAmount)).toEqual(['0.333333333333','0.333333333334','0.333333333333','0']);
    expect(resolve({ order }).issues).toContain('ACQUISITION_FEE_ALLOCATION_REQUIRED');
  });
  it('refuse un curseur de frais d’une autre ligne et un transport non alloué', () => {
    expect(resolveReceiptAcquisitionValue({ ...facts,order: { ...facts.order!,additionalFees: '1' } },'EUR',
      { orderLineId: articleId,beforeQuantity: '0',sourceRef: 'other-line' }).amount).toBeNull();
    expect(resolve({ order: { ...facts.order!,transportFees: '5' } }).issues).toContain('ORDER_TRANSPORT_ALLOCATION_REQUIRED');
  });
  it.each([
    { order: null }, { ownerClientId: 'CLI-001' }, { stockQuantity: '3001' }, { receiptUnit: 'kg' },
    { order: { ...facts.order!,currency: 'USD' } }, { order: { ...facts.order!,status: 'APPROUVEE' } },
    { order: { ...facts.order!,lineStatus: 'ANNULEE' } }, { order: { ...facts.order!,articleId: id } },
    { order: { ...facts.order!,unitPrice: '0' } }, { order: { ...facts.order!,unitPrice: '1e3' } },
  ])('laisse un coût non justifié inconnu : %j', change => {
    expect(resolve(change)).toMatchObject({ amount: null,unitCost: null,reliability: 'UNKNOWN' });
  });
  it('ne transforme pas un arrondi de conversion excessif en coût connu', () => {
    expect(resolve({ stockQuantity: '2999.999',conversionCoefficient: '1000' }).issues).toContain('RECEIPT_STOCK_QUANTITY_MISMATCH');
  });
  it('ne double pas les quantités de la réception et de ses portions', () => {
    const snapshot = { schema_version: 1,movement_id: id,article_id: articleId,stock_quantity: '3000',stock_unit: 'mm',
      owner_client_id: null,source_document_id: id,
      stock_lines: [{ article_id: articleId,quantity: '3000',unit: 'mm',owner_client_id: null }],
      receipts: [{ receipt_stock_id: id,reception_id: id,line_reception_id: id,receipt_line_id: id,receipt_quantity: '3',
        receipt_article_id: articleId,stock_article_id: articleId,receipt_unit: 'm',stock_unit: 'mm',conversion_coefficient: '1000',
        receipt_supplier_id: id,receipt_order_id: id,order: { id,line_id: id,article_id: articleId,status: 'ACCUSE_RECU',
          line_status: 'ACTIVE',unit: 'm',currency: 'EUR',quantity: '9',unit_price: '10',discount_percent: '10',
          additional_fees: '0',transport_fees: '0',supplier_id: id } }],
      portions: [{ id,receipt_line_id: id,receipt_quantity: '3',stock_quantity: '3000' }] };
    expect(resolveCapturedReceiptAcquisitionValue(snapshot,'EUR').amount).toBe('27');
    expect(resolveCapturedReceiptAcquisitionValue({ ...snapshot,portions: [{ ...snapshot.portions[0],stock_quantity: '6000' }] },'EUR'))
      .toMatchObject({ amount: null,issues: ['RECEIPT_PORTION_QUANTITY_MISMATCH'] });
    expect(resolveCapturedReceiptAcquisitionValue({ ...snapshot,receipts: [snapshot.receipts[0],snapshot.receipts[0]] },'EUR').amount).toBeNull();
    expect(resolveCapturedReceiptAcquisitionValue({ ...snapshot,stock_lines: [{ ...snapshot.stock_lines[0],owner_client_id: 'CLI-001' }] },'EUR').amount).toBeNull();
  });
});
