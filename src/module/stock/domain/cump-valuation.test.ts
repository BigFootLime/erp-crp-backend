import { describe, expect, it } from 'vitest';
import { applyCumpTransition, type CumpScope, type CumpState, type CumpTransition } from './cump-valuation';

const scope: CumpScope = { articleId: '985c0e4c-ec2e-4a55-bb21-64d6beea5a96', owner: 'COMPANY', unit: 'mm', currency: 'EUR' };
const empty: CumpState = { scope, quantity: '0', value: null, reliability: 'UNKNOWN', sourceRef: null };
const priced: CumpState = { scope, quantity: '20', value: '60', reliability: 'VERIFIED', sourceRef: 'stock-journal:20' };
const receipt = (quantity: string, amount: string | null): CumpTransition => ({ kind: 'RECEIPT', scope, quantity,
  movementRef: `receipt:${quantity}:${amount}`, cost: { amount, reliability: amount === null ? 'UNKNOWN' : 'DECLARED', sourceRef: amount === null ? null : 'purchase-line:confirmed' } });
const issue = (quantity: string): CumpTransition => ({ kind: 'ISSUE', scope, quantity, movementRef: 'out:new' });

describe('CUMP — noyau décimal du futur journal Stock', () => {
  it('pondère deux acquisitions et ne confond pas une moyenne de prix avec une moyenne de valeurs', () => {
    const first = applyCumpTransition(empty, receipt('10', '20')).after;
    const second = applyCumpTransition(first, receipt('5', '30')).after;
    expect(second).toMatchObject({ quantity: '15', value: '50', reliability: 'DECLARED' });
    expect(applyCumpTransition(second, issue('3'))).toMatchObject({ movementValue: '10', unitCost: '3.333333333333',
      after: { quantity: '12', value: '40', reliability: 'DECLARED' } });
  });
  it('la sortie finale reprend le reliquat exact malgré les divisions et arrondis successifs', () => {
    const third: CumpState = { ...priced, quantity: '3', value: '1' };
    const first = applyCumpTransition(third, issue('1'));
    const second = applyCumpTransition(first.after, issue('1'));
    const last = applyCumpTransition(second.after, issue('1'));
    expect(first.movementValue).toBe('0.333333333333');
    expect(second.movementValue).toBe('0.333333333334');
    expect(last.movementValue).toBe('0.333333333333');
    expect(last.after).toMatchObject({ quantity: '0', value: '0' });
  });
  it('une entrée sans prix et une ouverture OLD inconnue ne prennent jamais le prix de la dernière commande', () => {
    expect(applyCumpTransition(priced, receipt('5', null))).toMatchObject({ movementValue: null, valueDelta: null,
      after: { quantity: '25', value: null, reliability: 'UNKNOWN' }, issues: ['ENTRY_VALUE_UNKNOWN'] });
    const historical: CumpState = { ...empty, quantity: '5' };
    expect(applyCumpTransition(historical, receipt('5', '25')).after.value).toBeNull();
    const exhausted = applyCumpTransition(historical, issue('5'));
    expect(exhausted).toMatchObject({ movementValue: null, after: { quantity: '0', value: '0' } });
    expect(applyCumpTransition(exhausted.after, receipt('5', '25')).after.value).toBe('25');
  });
  it('une valeur explicitement nulle reste distincte d’une absence de preuve', () => {
    expect(applyCumpTransition(empty, receipt('10', '0')).after).toMatchObject({ value: '0', reliability: 'DECLARED' });
    expect(() => applyCumpTransition(empty, { ...receipt('10', '0'), kind: 'RECEIPT', cost: { amount: '0', reliability: 'UNKNOWN', sourceRef: null } })).toThrow('CUMP_COST_EVIDENCE_REQUIRED');
  });
  it('ne valorise pas les sorties négatives autorisées par le stock physique', () => {
    const negative = applyCumpTransition(priced, issue('21'));
    expect(negative).toMatchObject({ movementValue: null, unitCost: null, after: { quantity: '-1', value: null, reliability: 'UNKNOWN' }, issues: ['NEGATIVE_STOCK'] });
    expect(applyCumpTransition(negative.after, receipt('5', '20')).after).toMatchObject({ quantity: '4', value: null });
  });
  it.each([
    { ...scope, articleId: '0491c5c8-8500-4d88-a94f-177054c6677c' },
    { ...scope, owner: 'CLIENT:0491c5c8-8500-4d88-a94f-177054c6677c' as const },
    { ...scope, unit: 'kg' }, { ...scope, currency: 'USD' },
  ])('refuse de mélanger articles, propriété client, unités ou devises', changed => {
    expect(() => applyCumpTransition(priced, { ...issue('1'), scope: changed })).toThrow('CUMP_SCOPE_MISMATCH');
  });
  it('un déplacement interne ne compte ni acquisition ni consommation', () => {
    const transfer: CumpTransition = { kind: 'TRANSFER', scope, destinationScope: scope, quantity: '2', movementRef: 'transfer:paired' };
    expect(applyCumpTransition(priced, transfer)).toMatchObject({ quantityDelta: '0', valueDelta: '0', movementValue: null, after: priced });
    expect(() => applyCumpTransition(priced, { ...transfer, destinationScope: { ...scope, unit: 'kg' } })).toThrow('CUMP_TRANSFER_SCOPE_MISMATCH');
  });
  it('conserve le véritable code propriétaire client, sans le confondre avec un UUID ou un autre client', () => {
    const ownedScope = { ...scope, owner: 'CLIENT:CLI-001' as const };
    const owned = { ...priced, scope: ownedScope };
    expect(applyCumpTransition(owned, { ...issue('1'), scope: ownedScope }).after.scope.owner).toBe('CLIENT:CLI-001');
    expect(() => applyCumpTransition(owned, { ...issue('1'), scope: { ...ownedScope, owner: 'CLIENT:cli-001' } })).toThrow('CUMP_SCOPE_MISMATCH');
  });
  it('le retour conserve la valeur d’origine fournie par son propriétaire et ne crée pas un nouveau prix moyen supposé', () => {
    const returned = applyCumpTransition(priced, { kind: 'RETURN', scope, quantity: '2', movementRef: 'return:unused', originalMovementRef: 'out:original',
      cost: { amount: '4', reliability: 'VERIFIED', sourceRef: 'original-journal-entry' } });
    expect(returned).toMatchObject({ movementValue: '4', unitCost: '2', after: { quantity: '22', value: '64' } });
  });
  it.each(['1e6', '1,5', 'NaN', 'Infinity', '0.0000000000001', '0', '-1'])('refuse une quantité non décimale, trop précise ou non positive : %s', quantity => {
    expect(() => applyCumpTransition(priced, issue(quantity))).toThrow();
  });
  it('refuse les coûts non justifiés et une valeur résiduelle sur un stock vide', () => {
    expect(() => applyCumpTransition({ ...priced, sourceRef: null }, issue('1'))).toThrow('CUMP_COST_EVIDENCE_REQUIRED');
    expect(() => applyCumpTransition({ ...priced, quantity: '0', value: '1' }, issue('1'))).toThrow('CUMP_BALANCE_VALUE_INVALID');
  });
});
