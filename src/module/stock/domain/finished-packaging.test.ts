import { describe, it, expect } from 'vitest';
import { packagingPolicySchema, packagingPortions } from './finished-packaging';
describe('physical packaging portions', () => {
    it('preserves a partial final container', () => expect(packagingPortions(23, { mode: 'LOT', lotSize: 10 })).toEqual([10, 10, 3]));
    it('distinguishes global and unit labels', () => { expect(packagingPortions(3, { mode: 'GLOBAL', lotSize: null })).toEqual([3]); expect(packagingPortions(3, { mode: 'UNIT', lotSize: null })).toEqual([1, 1, 1]); });
    it('rejects a fractional lot and unbounded print run', () => { expect(packagingPolicySchema.safeParse({ mode: 'LOT', lotSize: 2.5 }).success).toBe(false); expect(() => packagingPortions(1001, { mode: 'UNIT', lotSize: null })).toThrow(); });
});
