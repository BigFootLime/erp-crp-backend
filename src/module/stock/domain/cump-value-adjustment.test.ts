import { describe, expect, it } from 'vitest';
import { applyCumpValueAdjustment } from './cump-value-adjustment';
import type { CumpState } from './cump-valuation';
import { valueAdjustmentBody } from '../validators/cump-value-adjustment.validators';

const prior = (value: string | null): CumpState => ({
  scope: { articleId: '11111111-1111-4111-8111-111111111111', owner: 'COMPANY', unit: 'U', currency: 'EUR' },
  quantity: '3', value, reliability: value === null ? 'UNKNOWN' : 'VERIFIED', sourceRef: 'stock-valuation-entry:prior',
});
describe('documented current-value adjustment — final combined acceptance fixtures', () => {
  it('keeps unknown historical value and quantity while establishing a documented current total', () => {
    const input = prior(null), result = applyCumpValueAdjustment(input, '12.000000000001', 'stock-valuation-entry:next');
    expect(result.before.value).toBeNull();
    expect(result.valueDelta).toBeNull();
    expect(result.movementValue).toBeNull();
    expect(result.issues).toEqual(['PREVIOUS_VALUE_UNKNOWN']);
    expect(result.after).toMatchObject({ quantity: '3', value: '12.000000000001', reliability: 'DECLARED' });
    expect(input).toEqual(prior(null));
  });
  it('retains the last decimal and signed difference beyond JavaScript safe integer precision', () => {
    const result = applyCumpValueAdjustment(prior('9007199254740993.000000000001'), '0.000000000001', 'stock-valuation-entry:next');
    expect(result.quantityDelta).toBe('0');
    expect(result.valueDelta).toBe('-9007199254740993');
    expect(result.movementValue).toBe('9007199254740993');
    expect(result.after.quantity).toBe('3');
  });
  it('refuses empty/client stock, inconsistent reliability and unsupported request amounts', () => {
    expect(() => applyCumpValueAdjustment({ ...prior('0'), quantity: '0' }, '1', 'next')).toThrow();
    expect(() => applyCumpValueAdjustment({ ...prior('1'), scope: { ...prior('1').scope, owner: 'CLIENT:customer' } }, '1', 'next')).toThrow();
    expect(() => applyCumpValueAdjustment({ ...prior(null), reliability: 'VERIFIED' }, '1', 'next')).toThrow();
    const body = { request_id: '11111111-1111-4111-8111-111111111111', document_id: '22222222-2222-4222-8222-222222222222',
      expected_source_sha256: 'a'.repeat(64), expected_document_sha256: 'b'.repeat(64), total_value_ht: '1' };
    for (const amount of ['-1', '1e3', '1.0000000000001', '100000000000000000000000000', '01', 'NaN']) {
      expect(valueAdjustmentBody.safeParse({ ...body, total_value_ht: amount }).success).toBe(false);
    }
    expect(valueAdjustmentBody.safeParse({ ...body, quantity: '4' }).success).toBe(false);
  });
});
