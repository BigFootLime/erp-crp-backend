import { describe, expect, it } from 'vitest';
import { getAssemblyComponentBalance, planAssemblyComponentConsumption, type AssemblyCoverage } from '../module/production/domain/assembly-component-consumption';

// Prepared for the final combined acceptance; do not execute per increment.
const version = '11111111-1111-4111-8111-111111111111';
function requirement(sourceOfId: number, target: number, perParent: string, consumed = 0, label = 'vis') {
  const required = target * Number(perParent);
  return { id: `${sourceOfId}-${label}`, label, sourceOfId, required, quantityPerParent: perParent,
    consumedQuantity: consumed * Number(perParent), parentVersionId: version, unit: 'u',
    lots: [{ id: `${sourceOfId}-${label}-reservation`, lotId: `${sourceOfId}-${label}-lot`, lotCode: `LOT-${sourceOfId}`,
      rowVersion: 2, usable: required - consumed * Number(perParent), quantity: required - consumed * Number(perParent) }] };
}
function coverage(items = [requirement(10, 100, '2.000000')], quantity = 100): AssemblyCoverage {
  return { ofId: 10, quantity, versionId: version, ready: true, definitionMissing: false, coveredByOfId: null, items };
}
describe('physical assemblies and component quantities', () => {
  it('retains a complete intake balance with no remaining issue and rejects a further explicit withdrawal', () => {
    const state = coverage([requirement(10, 100, '2', 100)]);
    expect(getAssemblyComponentBalance(state)).toEqual({ quantity: 100, alreadyInAssembly: 100, remaining: 0,
      sourceBalances: [{ sourceOfId: 10, quantity: 100, alreadyInAssembly: 100, remaining: 0 }] });
    expect(() => planAssemblyComponentConsumption(state, 1)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_QUANTITY_EXCEEDED' }));
  });
  it('reports each grouped source balance, including a fully withdrawn source beside an untouched source', () => {
    const state = coverage([requirement(10, 60, '2', 60), requirement(20, 10, '2', 0)], 70);
    expect(getAssemblyComponentBalance(state)).toEqual({ quantity: 70, alreadyInAssembly: 60, remaining: 10,
      sourceBalances: [{ sourceOfId: 10, quantity: 60, alreadyInAssembly: 60, remaining: 0 },
        { sourceOfId: 20, quantity: 10, alreadyInAssembly: 0, remaining: 10 }] });
  });
  it('does not manufacture a balance for contradictory component intakes or an obsolete frozen version', () => {
    const state = coverage([requirement(10, 100, '2', 20), requirement(10, 100, '3', 10)]);
    expect(() => getAssemblyComponentBalance(state)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_COMPONENT_BALANCE_UNKNOWN' }));
    state.items = [requirement(10, 100, '2', 100)]; state.items[0].parentVersionId = 'old';
    expect(() => getAssemblyComponentBalance(state)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_COMPONENT_VERSION_CHANGED' }));
  });
  it('takes 40 screws for 20 newly assembled pieces and leaves 80 assemblies available', () => {
    expect(planAssemblyComponentConsumption(coverage(), 20)).toMatchObject({ quantity: 20, remainingAfter: 80,
      allocations: [{ quantity: 40, sourceOfId: 10 }] });
  });
  it('prefills only the unconsumed remainder; output or rework are not intake inputs', () => {
    expect(planAssemblyComponentConsumption(coverage([requirement(10, 100, '2', 20)]))).toMatchObject({
      quantity: 80, alreadyInAssembly: 20, allocations: [{ quantity: 160 }] });
  });
  it('allocates a grouped 60 + 10 demand as whole source assemblies, not 35 + 35 component issues', () => {
    const state = coverage([requirement(10, 60, '2'), requirement(20, 10, '2')], 70);
    expect(planAssemblyComponentConsumption(state, 65)).toMatchObject({ sourceAllocations: [
      { sourceOfId: 10, assemblyQuantity: 60 }, { sourceOfId: 20, assemblyQuantity: 5 }], allocations: [
      { sourceOfId: 10, quantity: 120 }, { sourceOfId: 20, quantity: 10 }] });
  });
  it('keeps several positions of the same article additive without doubling the parent target', () => {
    expect(planAssemblyComponentConsumption(coverage([requirement(10, 100, '2', 0, 'gauche'), requirement(10, 100, '3', 0, 'droite')]), 20).allocations.map(item => item.quantity)).toEqual([40, 60]);
  });
  it('requires all physical components before a partial montage', () => {
    expect(() => planAssemblyComponentConsumption({ ...coverage(), ready: false }, 1)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_COMPONENTS_NOT_READY' }));
  });
  it('rejects inconsistent source consumption and an obsolete frozen version', () => {
    expect(() => planAssemblyComponentConsumption(coverage([requirement(10, 100, '2', 20), requirement(10, 100, '3', 10)]), 1)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_COMPONENT_BALANCE_UNKNOWN' }));
    const state = coverage(); state.items[0].parentVersionId = 'old-version';
    expect(() => planAssemblyComponentConsumption(state, 1)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_COMPONENT_VERSION_CHANGED' }));
  });
  it('preserves exact stock units and refuses a fractional milli-unit rather than rounding it', () => {
    expect(planAssemblyComponentConsumption(coverage([requirement(10, 1000, '0.001')], 1000), 1).allocations[0].quantity).toBe(0.001);
    expect(() => planAssemblyComponentConsumption(coverage([requirement(10, 1000, '0.000500')], 1000), 1)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_QUANTITY_PRECISION' }));
  });
  it('directs a consolidated source to its physical producer', () => {
    expect(() => planAssemblyComponentConsumption({ ...coverage(), coveredByOfId: 99 }, 1)).toThrowError(expect.objectContaining({ code: 'ASSEMBLY_PRODUCER_REQUIRED' }));
  });
});
