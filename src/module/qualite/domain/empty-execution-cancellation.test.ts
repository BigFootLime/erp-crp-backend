import { describe, it, expect } from 'vitest';
import { assertEmptyExecutionCancellation, type EmptyExecutionCancellationState } from './empty-execution-cancellation';
const empty: EmptyExecutionCancellationState = {
  status: 'IN_PROGRESS', validationDate: null, measurementCount: 0,
  measurementRevisionCount: 0, decisionCount: 0, quantities: Array(10).fill(0),
};
describe('empty quality execution cancellation', () => {
  it.each(['PLANNED', 'IN_PROGRESS'])('allows an empty %s workspace', status => {
    expect(() => assertEmptyExecutionCancellation({ ...empty, status })).not.toThrow();
  });
  it.each(['VALIDATED', 'REJECTED', 'CANCELLED', 'UNKNOWN'])('keeps a %s control closed', status => {
    expect(() => assertEmptyExecutionCancellation({ ...empty, status })).toThrow();
  });
  it('refuses validation even if a stale status says it is open', () => {
    expect(() => assertEmptyExecutionCancellation({ ...empty, validationDate: '2026-10-13' })).toThrow();
  });
  it.each(['measurementCount', 'measurementRevisionCount', 'decisionCount'] as const)('refuses existing %s evidence', field => {
    expect(() => assertEmptyExecutionCancellation({ ...empty, [field]: 1 })).toThrow();
  });
  it.each([1, -1, NaN, Infinity])('refuses a nonempty or untrustworthy ledger (%s)', quantity => {
    expect(() => assertEmptyExecutionCancellation({ ...empty, quantities: [quantity] })).toThrow();
  });
});
