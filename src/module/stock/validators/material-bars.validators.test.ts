import { describe, expect, it } from 'vitest';
import { materialBarInventoryCommand } from './material-bars.validators';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const command = () => ({ expectedVersion: 'a'.repeat(64), idempotencyKey: id(1), reason: '  Comptage réel  ', bars: [{ id: id(2), lengthMm: 3000, allocations: [{ reservationId: id(3), quantityMm: 200 }] }] });
describe('bar inventory API validation', () => {
  it('keeps decimal millimetres and trims the reason', () => { const input = command(); input.bars[0].lengthMm = 123.456; expect(materialBarInventoryCommand.parse(input).reason).toBe('Comptage réel'); });
  it.each([0,-1,NaN,Infinity,3000.0001,'3000','3 000,5',null])('rejects an invalid or noncanonical length %s', length => { expect(materialBarInventoryCommand.safeParse({ ...command(), bars: [{ ...command().bars[0], lengthMm: length }] }).success).toBe(false); });
  it('rejects duplicate bars and duplicate holds', () => {
    const input = command(); input.bars.push(input.bars[0]); expect(materialBarInventoryCommand.safeParse(input).success).toBe(false);
    const another = command(); another.bars[0].allocations.push(another.bars[0].allocations[0]); expect(materialBarInventoryCommand.safeParse(another).success).toBe(false);
  });
  it('rejects unknown fields and missing optimistic version', () => {
    expect(materialBarInventoryCommand.safeParse({ ...command(), bypass: true }).success).toBe(false);
    expect(materialBarInventoryCommand.safeParse({ ...command(), expectedVersion: '' }).success).toBe(false);
  });
  it('permits an empty physical inventory for a zero canonical balance', () => { expect(materialBarInventoryCommand.parse({ ...command(), bars: [] }).bars).toEqual([]); });
});
