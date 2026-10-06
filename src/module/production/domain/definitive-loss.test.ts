import { describe, it, expect } from 'vitest';
import { assertDefinitiveLoss } from './definitive-loss';
describe('definitive production loss', () => {
    const closed = { status: 'DONE', potential: false, loss: 7, covered: 2, quantity: 5 };
    it('excludes an unfinished partial production', () => expect(() => assertDefinitiveLoss({ ...closed, status: 'RUNNING' })).toThrow());
    it('excludes potential yield before turning', () => expect(() => assertDefinitiveLoss({ ...closed, potential: true })).toThrow());
    it('prevents covering the same definitive losses twice', () => expect(() => assertDefinitiveLoss({ ...closed, quantity: 6 })).toThrow());
    it('allows only the remaining definitive loss', () => expect(() => assertDefinitiveLoss(closed)).not.toThrow());
});
