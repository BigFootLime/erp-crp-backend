import { describe, it, expect } from 'vitest';
import { reconcileMaintenanceSlots } from './maintenance-schedule';
import type { MaintenanceSlot, MaintenanceOccurrence } from '../types/maintenance-schedule.types';
const now = '2027-01-01T00:00:00Z';
const slot = (patch: Partial<MaintenanceSlot> = {}): MaintenanceSlot => ({ schedule_id: 'weekly', schedule_version: 1, kind: 'LEVEL_1_WEEKLY', title: 'Entretien', notes: '', machine_id: 'm1', start_ts: '2027-01-07T09:00:00Z', end_ts: '2027-01-07T10:00:00Z', local_valid: true, execution_mode: 'INTERNAL', provider_id: null, responsible_user_id: null, maintenance_plan_id: null, ...patch });
const existing = (s: MaintenanceSlot, patch: Partial<MaintenanceOccurrence> = {}): MaintenanceOccurrence => ({ ...s, id: 'old', unavailability_id: 'u', planning_event_id: 'e', status: 'PLANNED', archived: false, snapshot: {}, ...patch });
const annual = () => slot({ schedule_id: 'annual', kind: 'LEVEL_2_ANNUAL', start_ts: '2027-01-04T08:00:00Z', end_ts: '2027-01-11T08:00:00Z' });
describe('maintenance calendar reconciliation', () => {
    it('reserves only the annual week when it contains the weekly slot', () => { const result = reconcileMaintenanceSlots([slot(), annual()], [], now); expect(result.create).toEqual([annual()]); expect(result.covered).toEqual([slot()]); });
    it('restores the weekly hour when a future annual week is removed', () => { const result = reconcileMaintenanceSlots([slot()], [existing(annual())], now); expect(result.create).toEqual([slot()]); expect(result.cancel).toHaveLength(1); expect(result.covered).toEqual([]); });
    it('preserves started annual maintenance and its weekly coverage', () => { const result = reconcileMaintenanceSlots([slot()], [existing(annual(), { status: 'IN_PROGRESS' })], now); expect(result.create).toEqual([]); expect(result.cancel).toEqual([]); expect(result.preserved).toHaveLength(1); });
    it('keeps the existing canonical slot on identical replay', () => { const result = reconcileMaintenanceSlots([slot()], [existing(slot())], now); expect(result.create).toEqual([]); expect(result.cancel).toEqual([]); expect(result.unchanged).toBe(1); });
    it('requires resolution of a partially overlapping annual week', () => { const result = reconcileMaintenanceSlots([slot(), annual(), slot({ schedule_id: 'second', start_ts: '2027-01-11T07:30:00Z', end_ts: '2027-01-11T08:30:00Z' })], [], now); expect(result.conflicts).toHaveLength(1); });
    it('never cancels a past or begun occurrence when its rule is disabled', () => { const result = reconcileMaintenanceSlots([], [existing(slot())], '2027-01-07T09:30:00Z'); expect(result.cancel).toEqual([]); expect(result.preserved).toHaveLength(1); });
    it('rejects a nonexistent or ambiguous local clock slot', () => { expect(reconcileMaintenanceSlots([slot({ local_valid: false })], [], now).conflicts).toHaveLength(1); });
});
