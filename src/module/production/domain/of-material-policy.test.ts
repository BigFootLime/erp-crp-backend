import { describe, expect, it } from 'vitest';
import { assertMaterialOriginLimit, missingPhysicalMaterial, type MaterialOriginPolicy } from './of-material-policy';

const policy = (critical = false): MaterialOriginPolicy => ({ critical, maximumLots: critical ? 1 : 2,
  usedOrigins: ['heat-a'], originsByLot: { bar: ['heat-a'], remnant: ['heat-a'], second: ['heat-b'], third: ['heat-c'] } });

describe('whole-OF raw material policy', () => {
  it('keeps bars and their remnants in one origin', () => {
    expect(assertMaterialOriginLimit(policy(true), ['bar', 'remnant'])).toEqual(['heat-a']);
  });
  it('counts a consumed origin even when the remaining need uses another lot', () => {
    expect(assertMaterialOriginLimit(policy(), ['second'])).toEqual(['heat-a', 'heat-b']);
    expect(() => assertMaterialOriginLimit(policy(), ['second', 'third'])).toThrow('Deux lots matière maximum');
  });
  it('rejects a second origin on critical production', () => {
    expect(() => assertMaterialOriginLimit(policy(true), ['second'])).toThrow('Pièce critique');
  });
  it('refuses unresolved genealogy instead of treating it as a verified origin', () => {
    expect(() => assertMaterialOriginLimit(policy(), ['unknown'])).toThrow('origine matière');
  });
  it('requires the physical remainder after recorded consumption', () => {
    expect(missingPhysicalMaterial([{ key: 'raw', designation: 'Aluminium', unit: 'mm', required: 1000,
      consumed: 700, usableReserved: 300, blockers: [] }])).toEqual([]);
    expect(missingPhysicalMaterial([{ key: 'raw', designation: 'Aluminium', unit: 'mm', required: 1000,
      consumed: 700, usableReserved: 200, blockers: [] }])[0].missing).toBe(100);
  });
  it('keeps a quarantined reservation blocking even with sufficient nominal quantity', () => {
    expect(missingPhysicalMaterial([{ key: 'raw', designation: 'Aluminium', unit: 'mm', required: 1000,
      consumed: 0, usableReserved: 1000, blockers: ['Lot en quarantaine'] }])[0].blockers).toEqual(['Lot en quarantaine']);
  });
});
