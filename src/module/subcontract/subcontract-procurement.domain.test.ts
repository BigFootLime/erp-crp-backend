import { describe, expect, it } from 'vitest';
import { assertSubcontractPieceUnit, assertSubcontractQuantityCeiling } from './subcontract-procurement.domain';
describe('Supplier quantities by material origin', () => {
    it('accepts a closed operation with sufficient good pieces', () => {
        expect(() => assertSubcontractQuantityCeiling(97, 100, [{ status: 'DONE', good: 97 }])).not.toThrow();
    });
    it('keeps supplier validation blocked while the preceding operation continues', () => {
        expect(() => assertSubcontractQuantityCeiling(30, 100, [{ status: 'IN_PROGRESS', good: 30 }])).toThrow('Clôturez');
    });
    it('rejects the initial 100 when three pieces were definitively lost', () => {
        expect(() => assertSubcontractQuantityCeiling(100, 100, [{ status: 'DONE', good: 97 }])).toThrow('réellement conformes');
    });
    it('rejects an edited quantity beyond the OF even for the first operation', () => {
        expect(() => assertSubcontractQuantityCeiling(101, 100, [])).toThrow('dépasse');
    });
    it('requires enough pieces from each explicit predecessor', () => {
        expect(() => assertSubcontractQuantityCeiling(80, 100, [{ status: 'DONE', good: 100 }, { status: 'DONE', good: 79 }])).toThrow('réellement conformes');
    });
    it('does not interpret a piece count as kilograms or millimetres', () => {
        expect(() => assertSubcontractPieceUnit('u')).not.toThrow();
        expect(() => assertSubcontractPieceUnit('PCE')).not.toThrow();
        expect(() => assertSubcontractPieceUnit('kg')).toThrow('conversion');
        expect(() => assertSubcontractPieceUnit('mm')).toThrow('conversion');
    });
});
