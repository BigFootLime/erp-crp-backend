import { describe, expect, it } from 'vitest';
import { evaluateUrgencyRecoveryApproval, type UrgencyRecoveryEvidence } from './urgency-recovery-approval';
import { evaluateRecoveryComponents } from './urgency-recovery-components';
import { estimateDuration } from './central-estimation';
import type { CentralSnapshot, CentralTask, DemandCoverage } from '../types/planning-central.types';

const now = '2026-10-12T06:00:00.000Z';
const at = (hour: number) => `2026-10-12T${String(hour).padStart(2,'0')}:00:00.000Z`;
function task(id = 'cut', patch: Partial<CentralTask> = {}): CentralTask {
  return { id: `op:${id}`, source: 'OPERATION', operationId: id, programmingId: null, ofId: 101, orderId: 20,
    ofNumber: 'OF-RECUP', reference: 'PIECE', revision: 'A', label: id, view: 'machines', internal: false,
    internalPurpose: null, quantity: 10, good: 0, scrap: 0, rework: 0, released: 0,
    resourceIds: ['machine:1'], eligibleResourceIds: ['machine:1'], committed: { start: at(8), end: at(9) },
    forecast: null, actual: null, commitment: 'COMMITTED', locked: false, readiness: 'READY', blockers: [],
    earliestStart: null, due: null, priority: 0, createdAt: now, version: '1',
    estimate: estimateDuration({ contextKey: id, routingSetupMinutes: 0, routingUnitMinutes: 6,
      quantity: 10, good: 0, scrap: 0, rework: 0, observations: [] }), ...patch };
}
function snapshot(tasks = [task()]): CentralSnapshot {
  return { apiVersion: 2, revision: '1', generatedAt: now, stale: false, activation: 'COMMIT', tasks,
    resources: [{ id: 'machine:1', kind: 'MACHINE', label: 'Takumi', timezone: 'Europe/Paris', version: '1',
      availability: [{ start: at(6), end: at(20) }] }], dependencies: [], sources: [], demands: [], allocations: [],
    coverageAvailable: true, total: tasks.length, nextCursor: null };
}
const recovery = (): UrgencyRecoveryEvidence => ({ recovery_id: 'recovery', of_id: 101, of_ids: [101], quantity: '10',
  protected_before: '2026-10-13T22:00:00.000Z', current_protected_before: '2026-10-13T22:00:00.000Z',
  dossier_complete: true, identity_matches: true, operation_ids: ['cut'] });
const evaluate = (state = snapshot(), evidence = recovery()) => evaluateUrgencyRecoveryApproval({ snapshot: state, recoveries: [evidence], now });
const codes = (state: CentralSnapshot, evidence = recovery()) => evaluate(state,evidence).issues.map(issue => issue.code);

describe('recovery approval on existing canonical commitments', () => {
  it('accepts a feasible commitment without modifying the snapshot', () => {
    const state = snapshot(), before = structuredClone(state);
    expect(evaluate(state)).toMatchObject({ can_approve: true, issues: [], recoveries: [{ planned_finish: at(9) }] });
    expect(state).toEqual(before);
  });
  it.each(['identity_matches','dossier_complete'] as const)('refuses incomplete evidence: %s', field => {
    expect(evaluate(snapshot(),{ ...recovery(), [field]: false }).can_approve).toBe(false);
  });
  it('requires every operation, including a missing final control', () => {
    expect(codes(snapshot(),{ ...recovery(), operation_ids: ['cut','control'] })).toContain('RECOVERY_OPERATIONS_MISSING');
  });
  it('rejects a provisional forecast and a started operation', () => {
    expect(codes(snapshot([task('cut',{ committed: null, commitment: 'FORECAST' })]))).toContain('RECOVERY_NOT_PLANNED');
    expect(codes(snapshot([task('cut',{ actual: { start: at(8) }, commitment: 'STARTED' })]))).toContain('RECOVERY_NOT_PLANNED');
  });
  it('protects the earlier current promise, but never relaxes the original deadline', () => {
    expect(codes(snapshot(),{ ...recovery(), current_protected_before: at(9) })).toContain('RECOVERY_TOO_LATE');
    expect(codes(snapshot(),{ ...recovery(), protected_before: at(9) })).toContain('RECOVERY_TOO_LATE');
  });
  it('handles invalid dates without returning a server error', () => {
    expect(evaluate(snapshot(),{ ...recovery(), protected_before: 'invalid' })).toMatchObject({ can_approve: false, recoveries: [{ finish_before: null }] });
    expect(codes(snapshot([task('cut',{ committed: { start: 'invalid', end: at(9) } })]))).toContain('RECOVERY_NOT_PLANNED');
  });
  it('rejects a missing donor promise and a past slot', () => {
    expect(codes(snapshot(),{ ...recovery(), current_protected_before: null })).toContain('DONOR_PROMISE_MISSING');
    expect(codes(snapshot([task('cut',{ committed: { start: at(5), end: at(6) } })]))).toContain('RECOVERY_PLAN_OVERDUE');
  });
  it('detects a collision in the reserved buffer, including machine/post aliases', () => {
    const state = snapshot([task('cut',{ committed: { start: at(8), end: at(12) } }),
      task('other',{ ofId: 200, committed: { start: at(10), end: at(11) }, resourceIds: ['poste:1'] })]);
    state.resources[0].capacityId = 'physical:1';
    state.resources.push({ ...state.resources[0], id: 'poste:1', kind: 'POSTE' });
    expect(codes(state)).toContain('RECOVERY_CAPACITY_OVERLAP');
  });
  it('allows back-to-back slots and rejects a maintenance gap or disabled machine', () => {
    expect(evaluate(snapshot([task(),task('other',{ ofId: 200, committed: { start: at(9), end: at(10) } })])).can_approve).toBe(true);
    const state = snapshot(); state.resources[0].availability = [{ start: at(9), end: at(20) }];
    expect(codes(state)).toContain('RECOVERY_REPLAN_REQUIRED');
    state.resources[0].capacityEnabled = false;
    expect(codes(state)).toContain('RECOVERY_RESOURCE_UNAVAILABLE');
  });
  it('refuses an unresolved prerequisite rather than shifting another commitment', () => {
    const state = snapshot([task(),task('program',{ source: 'PROGRAMMING', ofId: null, committed: null, commitment: 'FORECAST' })]);
    state.dependencies = [{ predecessorId: 'op:program', successorId: 'op:cut', lagMinutes: 0, releasedQuantity: 0, transferQuantity: null }];
    expect(codes(state)).toContain('RECOVERY_DEPENDENCY_UNCOMMITTED');
  });
  it('accepts an already completed prerequisite', () => {
    const state = snapshot([task(),task('program',{ source: 'PROGRAMMING', ofId: null, committed: null,
      commitment: 'DONE', actual: { end: at(7) } })]);
    state.dependencies = [{ predecessorId: 'op:program', successorId: 'op:cut', lagMinutes: 0, releasedQuantity: 0, transferQuantity: null }];
    expect(evaluate(state).can_approve).toBe(true);
  });
  it('requires an operational planning mode and complete coverage reads', () => {
    const state = snapshot(); state.activation = 'SIMULATE'; state.coverageAvailable = false; state.nextCursor = 'page2';
    expect(codes(state)).toEqual(expect.arrayContaining(['PLANNING_NOT_COMMITTABLE','MATERIAL_COVERAGE_UNAVAILABLE','PLANNING_INCOMPLETE']));
  });
  it('counts firm future supplies available before the operation, not unassigned free stock', () => {
    const state = snapshot();
    const coverage: DemandCoverage = { ofId: 101, operationId: 'cut', sourceRef: 'need1', label: 'Acier', kind: 'MATERIAL',
      consumed: 0, reserved: 0, usableReserved: 0, reservedBlocked: 0, stockAvailable: 10, expected: 10,
      receivedBlocked: 0, draft: 0, missing: 0, toPrepare: 0, unsecured: 0, availableAt: at(7), issues: [], sourceIds: ['purchase1'] };
    state.demands = [{ id: 'need1', articleId: 'steel', compatibleRevisions: [null], unit: 'MM', contractId: null, quantity: 10, due: at(8), coverage }];
    expect(evaluate(state).can_approve).toBe(true);
    coverage.expected = 0; coverage.unsecured = 10;
    expect(codes(state)).toContain('RECOVERY_SUPPLY_UNSECURED');
    coverage.unsecured = 0; coverage.availableAt = at(9);
    expect(codes(state)).toContain('RECOVERY_SUPPLY_UNSECURED');
    coverage.availableAt = at(7); coverage.reservedBlocked = 1;
    expect(codes(state)).toContain('RECOVERY_SUPPLY_UNSECURED');
  });
});

describe('approval after a reviewed grouping addition', () => {
  const running = () => snapshot([task('cut', { commitment: 'STARTED', actual: { start: at(5) }, committed: { start: at(5), end: at(8) } })]);
  const evidence = () => ({ ...recovery(), allow_execution: true, grouping_addition_id: 'addition' });
  it('checks the remaining load of a running group without rewriting its original start', () => {
    const state = running(), before = structuredClone(state);
    expect(evaluate(state,evidence()).can_approve).toBe(true);
    expect(state).toEqual(before);
    expect(evaluate(state).can_approve).toBe(false);
    expect(evaluateUrgencyRecoveryApproval({snapshot:state,recoveries:[recovery()],now,allowExecution:true}).can_approve).toBe(true);
  });
  it('still blocks lost yield, unavailable capacity and stale running slots', () => {
    const state = running(); state.tasks[0].scrap = 1;
    expect(codes(state,evidence())).toContain('RECOVERY_YIELD_UNSECURED');
    state.tasks[0].scrap = 0; state.resources[0].capacityEnabled = false;
    expect(codes(state,evidence())).toContain('RECOVERY_RESOURCE_UNAVAILABLE');
    state.resources[0].capacityEnabled = true; state.tasks[0].committed!.end = now;
    expect(codes(state,evidence())).toContain('RECOVERY_PLAN_OVERDUE');
  });
  it('requires actual completion and full good quantity before relying on a completed operation', () => {
    const state=snapshot([task('cut',{commitment:'DONE',actual:{start:at(4),end:at(5)},good:10})]);
    expect(evaluate(state,evidence())).toMatchObject({can_approve:true,recoveries:[{planned_finish:at(5)}]});
    state.tasks[0].good=9;
    expect(codes(state,evidence())).toContain('RECOVERY_QUANTITY_UNSECURED');
    state.tasks[0].good=10;
    expect(codes(state,{...evidence(),protected_before:at(5)})).toContain('RECOVERY_TOO_LATE');
  });
  it('does not treat a future or invalid actual timestamp as work already done', () => {
    const state=running();state.tasks[0].actual={start:at(7)};
    expect(codes(state,evidence())).toContain('RECOVERY_ACTUAL_DATE_INVALID');
    state.tasks[0]={...state.tasks[0],commitment:'DONE',actual:{end:at(7)},good:10};
    expect(codes(state,evidence())).toContain('RECOVERY_ACTUAL_DATE_INVALID');
    state.tasks[0].actual={end:'invalid'};
    expect(codes(state,evidence())).toContain('RECOVERY_ACTUAL_DATE_INVALID');
  });
});

describe('assembly recovery component commitments', () => {
  const state = () => {
    const value = snapshot([task('cut',{ ofId: 102 }), task('assembly',{ ofId: 101, operationType: 'ASSEMBLAGE', committed: { start: at(10), end: at(11) } })]);
    value.dependencies = [{ predecessorId: 'op:cut', successorId: 'op:assembly', lagMinutes: 0, transferQuantity: null, releasedQuantity: 0 }];
    return value;
  };
  const coverage = [{ ofId: 101, definitionMissing: false, items: [{ label: 'Axe', missing: 10, childOfId: 102 }] }];
  it('accepts reserved components or explicitly linked child production', () => {
    expect(evaluateRecoveryComponents(coverage,[{ id: 102, quantity: 10 }],state())).toEqual([]);
    expect(evaluateRecoveryComponents([{ ...coverage[0], items: [{ label: 'Axe', missing: 0, childOfId: null }] }],[],state())).toEqual([]);
  });
  it('rejects a child outside the recovery and an unlinked child schedule', () => {
    expect(evaluateRecoveryComponents(coverage,[],state())).toHaveLength(1);
    expect(evaluateRecoveryComponents(coverage,[{ id: 102, quantity: 10 }],{ ...state(), dependencies: [] })).toHaveLength(1);
  });
  it('does not count the same child quantity twice', () => {
    expect(evaluateRecoveryComponents([{ ...coverage[0], items: [...coverage[0].items,...coverage[0].items] }],
      [{ id: 102, quantity: 10 }],state())).toHaveLength(1);
  });
  it('requires a defined assembly structure', () => {
    expect(evaluateRecoveryComponents([{ ofId: 101, definitionMissing: true, items: [] }],[],state())[0].code).toBe('RECOVERY_COMPONENT_DEFINITION');
  });
});
