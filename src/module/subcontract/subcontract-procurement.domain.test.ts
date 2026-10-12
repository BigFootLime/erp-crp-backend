import { describe, expect, it } from 'vitest';
import { assertSubcontractPieceUnit, assertSubcontractQuantityCeiling, assertSubcontractSupplement } from './subcontract-procurement.domain';
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

describe('additional supplier quantities for a single service', () => {
    const line = () => ({ purchaseId: 'coat', operationId: 'op', originId: 'lot', quantity: 100, status: 'ENVOYEE' });
    const input = () => ({ purchaseId: 'coat', operationId: 'op', ofQuantity: 110, lines: [line()],
        rows: [{ originId: 'lot', quantity: 10 }], predecessors: [{ status: 'DONE', good: 110 }] });
    it('allows a ten-piece supplement without changing a hundred-piece shipment', () => {
        const value = input(), before = structuredClone(value);
        expect(() => assertSubcontractSupplement(value)).not.toThrow();
        expect(value).toEqual(before);
    });
    it('does not count another service on the same phase and origin', () => {
        const value = input(); value.lines.push({ ...line(), purchaseId: 'polish', quantity: 110, status: 'BROUILLON' });
        expect(() => assertSubcontractSupplement(value)).not.toThrow();
    });
    it.each(['BROUILLON', 'A_VALIDER'])('requires adjustment of an existing %s for the same service and origin', status => {
        const value = input(); value.lines[0].status = status;
        expect(() => assertSubcontractSupplement(value)).toThrow('Un brouillon');
    });
    it('counts earlier supplements and all origins towards the service ceiling', () => {
        const value = input(); value.lines.push({ ...line(), originId: 'other-lot', quantity: 5 });
        expect(() => assertSubcontractSupplement(value)).toThrow('dépasse');
    });
    it('keeps the actual good-piece ceiling after predecessor closure', () => {
        const value = input(); value.predecessors[0].good = 107;
        expect(() => assertSubcontractSupplement(value)).toThrow('réellement conformes');
    });
    it('does not assign an unidentified historical line to an arbitrary service', () => {
        const value = { ...input(), lines: [{ ...line(), purchaseId: null }] };
        expect(() => assertSubcontractSupplement(value)).toThrow('historiques');
    });
});
