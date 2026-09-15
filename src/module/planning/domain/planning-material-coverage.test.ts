import { describe, expect, it } from 'vitest';
import type { readMaterialTx } from '../../production/repository/of-material.repository';
import { materialBalance } from '../../production/domain/of-material';
import { futureSupplyBalance } from '../../production/domain/material-future-supply';
import type { CentralTask } from '../types/planning-central.types';
import { projectMaterialCoverage } from './planning-material-coverage';

type Material = Awaited<ReturnType<typeof readMaterialTx>>;
const now = '2026-09-14T08:00:00.000Z';
function fixture() {
  return {ofId: 42, version: 'v1', previousNeeds: [], customerCalls: [], needs: [{id: 'n', key: 'p', articleId: 'a', unit: 'PCE', operationId: 'op',
    designation: 'Bruts', requirements: {ownerClientId: null}, supplyMode: 'PURCHASE', destinationId: null, required: 100, consumed: 0, reserved: 30,
    missing: 0, purchaseMissing: 0, receivedBlocked: 0, expected: 70, blockers: [], candidates: [], selections: [], futureSupplies: [],
    reservations: [{id: 'r', status: 'ACTIVE', unexpired: true, qty_reserved: 30, qty_consumed: 0, lot_code: 'LOT-1'}],
    promises: [{id: 'p1', command_id: 'order', line_id: 'line', code: 'ACHAT-1', statut: 'ACCUSE_RECU', due: '2026-09-20',
      assigned: 70, received: 0, transferred: 0, article_id: 'a', unite: 'PCE', purchase_unit: 'PCE', coefficient: 1, owner_client_id: null, destination_id: null}],
  }]} as unknown as Material;
}
const task = {ofId: 42, operationId: 'op', committed: {start: '2026-09-18T08:00:00Z'}, forecast: null} as CentralTask;
function project(material = fixture(), usable = 30) {
  return projectMaterialCoverage(material, [task], new Map([['p', {usable, reservations: new Map([['r', usable]]), blockers: usable === 30 ? [] : ['Lot en quarantaine.']}]]), now);
}
describe('planning material evidence', () => {
  it('shows 30 reserved + 70 assigned and warns about the September 18 commitment', () => {
    const output = project(), coverage = output.demands[0].coverage!;
    expect(coverage).toMatchObject({reserved: 30, usableReserved: 30, expected: 70, missing: 0, availableAt: '2026-09-20T00:00:00.000Z'});
    expect(coverage.issues).toContain('Approvisionnement disponible après le démarrage engagé ou prévu.');
    expect(output.allocations.reduce((s, a) => s + a.quantity, 0)).toBe(100);
    expect(task.committed!.start).toBe('2026-09-18T08:00:00Z');
  });
  it('moves every partial receipt from future to blocked, then only to the stock reservation', () => {
    const m = fixture(), need = m.needs[0], promise = need.promises[0];
    promise.received = 20;
    let result = project(m);
    expect(result.demands[0].coverage).toMatchObject({expected: 50, receivedBlocked: 20, usableReserved: 30, availableAt: null});
    expect(result.sources.filter(s => s.scope === 'ASSIGNED').reduce((s, a) => s + a.quantity, 0)).toBe(100);
    promise.transferred = 20; need.reserved = 50; need.reservations[0].qty_reserved = 50;
    result = projectMaterialCoverage(m, [task], new Map([['p', {usable: 50, reservations: new Map([['r', 50]]), blockers: []}]]), now);
    expect(result.demands[0].coverage).toMatchObject({expected: 50, receivedBlocked: 0, usableReserved: 50, availableAt: '2026-09-20T00:00:00.000Z'});
    expect(result.sources.reduce((s, a) => s + a.quantity, 0)).toBe(100);
    expect(result.sources.some(s => s.id.endsWith(':received'))).toBe(false);
  });
  it('does not allow a quarantined reservation to establish availability', () => {
    const result = project(fixture(), 0);
    expect(result.demands[0].coverage).toMatchObject({reserved: 30, usableReserved: 0, reservedBlocked: 30, availableAt: null});
    expect(result.sources.find(s => s.id === 'reservation:r')).toMatchObject({state: 'BLOCKED', usable: false});
  });
  it.each(['BROUILLON', 'VALIDEE'])('keeps %s as a hypothesis without ordering again', status => {
    const m = fixture(); m.needs[0].promises[0].statut = status;
    expect(project(m).demands[0].coverage).toMatchObject({expected: 0, draft: 70, missing: 0, toPrepare: 0, availableAt: null});
  });
  it.each([{unite: 'KG'}, {owner_client_id: 'other-client'}, {destination_id: 'other-store'}, {article_id: 'other-article'}, {purchase_unit: 'PACK', coefficient: 1}])('retains incompatible commitments as evidence without securing a start: %j', change => {
    const m = fixture(); Object.assign(m.needs[0].promises[0], change);
    expect(project(m).demands[0].coverage).toMatchObject({expected: 70, unsecured: 70, availableAt: null});
    expect(project(m).sources.find(s => s.kind === 'PURCHASE')?.usable).toBe(false);
  });
  it('accepts quantities already converted by the purchase module', () => {
    const m = fixture(); Object.assign(m.needs[0].promises[0], {purchase_unit: 'PACK', coefficient: 10});
    expect(project(m).demands[0].coverage).toMatchObject({expected: 70, unsecured: 0, availableAt: '2026-09-20T00:00:00.000Z'});
  });
  it('recalculates changed, missing and overdue dates', () => {
    const m = fixture(); m.needs[0].promises[0].due = '2026-09-17';
    expect(project(m).demands[0].coverage!.issues).toEqual([]);
    m.needs[0].promises[0].due = '2026-09-13';
    expect(project(m).demands[0].coverage!.availableAt).toBeNull();
    m.needs[0].promises[0].due = null;
    expect(project(m).demands[0].coverage!.availableAt).toBeNull();
  });
  it('preserves the canonical shortage after an assignment cancellation', () => {
    const m = fixture(), need = m.needs[0]; need.promises = []; need.expected = 0;
    Object.assign(need, materialBalance(need), {purchaseMissing: 70});
    expect(project(m).demands[0].coverage).toMatchObject({expected: 0, missing: 70, toPrepare: 70, availableAt: null});
  });
  it('never reallocates the 85 units assigned to other, hidden OFs', () => {
    const m = fixture(), need = m.needs[0];
    const balance = futureSupplyBalance({ordered: 100, cancelled: 0, coefficient: 1, assigned: 85, received: 40, allocationEnd: 85});
    need.futureSupplies = [{id: 'shared-line', commandId: 'shared-order', code: 'SHARED', status: 'ACCUSE_RECU', reasons: [], due: '2026-09-20', ...balance}] as unknown as typeof need.futureSupplies;
    const output = project(m);
    expect(output.sources.find(s => s.id === 'purchase-line:shared-line:free')!.quantity).toBe(15);
    expect(output.allocations.some(a => a.sourceId.includes('shared-line'))).toBe(false);
    expect(output.demands[0].coverage!.expected).toBe(70);
  });
  it('keeps unassigned physical stock as a proposal, not a forecast promise', () => {
    const m = fixture(), need = m.needs[0]; need.promises = []; need.expected = 0;
    need.selections = [{batchId: 'b', lotId: 'l', quantity: 70}];
    need.candidates = [{lot: {batchId: 'b', code: 'FREE'}}] as typeof need.candidates;
    Object.assign(need, materialBalance(need), {purchaseMissing: 0});
    const output = project(m);
    expect(output.demands[0].coverage).toMatchObject({stockAvailable: 70, missing: 70, toPrepare: 0, availableAt: null});
    expect(output.allocations).toHaveLength(1);
  });
  it('keeps three-decimal receipt arithmetic stable', () => {
    const m = fixture(); Object.assign(m.needs[0].promises[0], {assigned: 0.3, received: 0.1, transferred: 0.1});
    expect(project(m).demands[0].coverage!.expected).toBe(0.2);
  });
});
