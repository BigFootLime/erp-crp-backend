import test from 'node:test';
import assert from 'node:assert/strict';
import { materialSourceYields } from '../module/production/domain/material-source-yield';
import { buildOfTraveler } from '../module/production/domain/of-traveler';

const bar = { form: 'BAR' as const, stockUnit: 'mm', unitsPerBlank: 20, kerfPerBlank: 0, yieldValidated: true };

test('single source can unambiguously inherit the global observed counts', () => {
  assert.deepEqual(materialSourceYields({ rule: bar, good: 9, scrap: 1, sources: [{ id: 'one', quantity: 200 }] }),
    [{ id: 'one', good: 9, scrap: 1 }]);
});
test('multiple sources cannot infer a yield from their length ratio', () => {
  assert.throws(() => materialSourceYields({ rule: bar, good: 10, scrap: 0,
    sources: [{ id: 'one', quantity: 100 }, { id: 'two', quantity: 100 }] }), /chaque lot matière/);
});
test('observed two-lot yields must reconcile good and scrap independently', () => {
  assert.deepEqual(materialSourceYields({ rule: bar, good: 9, scrap: 1, sources: [
    { id: 'one', quantity: 120, yield: { good: 5, scrap: 1 } },
    { id: 'two', quantity: 80, yield: { good: 4, scrap: 0 } },
  ] }), [{ id: 'one', good: 5, scrap: 1 }, { id: 'two', good: 4, scrap: 0 }]);
  assert.throws(() => materialSourceYields({ rule: bar, good: 9, scrap: 1, sources: [
    { id: 'one', quantity: 120, yield: { good: 6, scrap: 0 } },
    { id: 'two', quantity: 80, yield: { good: 4, scrap: 0 } },
  ] }), /totaux du débit/);
});
test('each UNIT source respects the conversion even when global quantities balance', () => {
  assert.throws(() => materialSourceYields({ rule: { ...bar, form: 'UNIT', stockUnit: 'u', unitsPerBlank: 1 },
    good: 10, scrap: 0, sources: [
      { id: 'one', quantity: 5, yield: { good: 4, scrap: 0 } },
      { id: 'two', quantity: 5, yield: { good: 6, scrap: 0 } },
    ] }), /unités prélevées/);
});
test('opposite measured variances cannot cancel without an explanation', () => {
  const input = { rule: bar, good: 10, scrap: 0, sources: [
    { id: 'one', quantity: 100, yield: { good: 4, scrap: 0 } },
    { id: 'two', quantity: 100, yield: { good: 6, scrap: 0 } },
  ] };
  assert.throws(() => materialSourceYields(input), /écarts de rendement par lot/);
  assert.equal(materialSourceYields({ ...input, varianceReason: 'Rendement réel contrôlé sur les deux barres.' }).length, 2);
});
test('fractional or negative observed blanks fail before stock is consumed', () => {
  assert.throws(() => materialSourceYields({ rule: bar, good: 1, scrap: 0,
    sources: [{ id: 'one', quantity: 20, yield: { good: 0.5, scrap: 0 } }] }), /entière/);
});
test('traveler carries signed observed yields and preserves historical unknowns', () => {
  const document = buildOfTraveler({ of: { numero: 'OF-01' }, debits: [{ id: 'one' }, { id: 'undo' }], cuts: [
    { debit_id: 'one', lot: 'MP-A', good: 5, scrap: 1 },
    { debit_id: 'undo', lot: 'MP-A', good: -5, scrap: -1 },
    { debit_id: 'old', lot: 'MP-B', good: null, scrap: null },
  ] });
  const rows = document.sections.find(s => s.title.startsWith('Bruts obtenus par lot'))!.table!.rows;
  assert.equal(rows[0].good, '5');
  assert.equal(rows[1].good, '-5');
  assert.equal(rows[2].good, 'Non renseigné');
});
