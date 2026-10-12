import { describe, expect, it } from 'vitest';
import { maintenanceScheduleDefinitionSchema } from './maintenance-schedule.validators';
const target = { machine_id: '00000000-0000-4000-8000-000000000001' };
const annual = { kind: 'LEVEL_2_ANNUAL', title: 'Maintenance annuelle', year: 2027, entries: [{ ...target, start_date: '2027-01-07', start_time: '08:00', execution_mode: 'INTERNAL' }] };
describe('Maintenance schedule defaults', () => {
  it('proposes Thursday for one hour but permits changing the weekday', () => {
    const rule = { kind: 'LEVEL_1_WEEKLY', title: 'Entretien du jeudi', start_date: '2027-01-01', end_date: '2027-12-31', start_time: '09:00', targets: [target] };
    expect(maintenanceScheduleDefinitionSchema.parse(rule)).toMatchObject({ weekday: 4, duration_minutes: 60 });
    expect(maintenanceScheduleDefinitionSchema.parse({ ...rule, weekday: 2 })).toMatchObject({ weekday: 2, duration_minutes: 60 });
  });
  it('defaults new annual rules to one day and keeps explicit existing durations', () => {
    expect(maintenanceScheduleDefinitionSchema.parse(annual)).toMatchObject({ duration_days: 1 });
    expect(maintenanceScheduleDefinitionSchema.parse({ ...annual, duration_days: 7 })).toMatchObject({ duration_days: 7 });
  });
  it.each([0, -1, 1.5, 31])('rejects invalid day duration %s', duration_days => {
    expect(maintenanceScheduleDefinitionSchema.safeParse({ ...annual, duration_days }).success).toBe(false);
  });
  it('does not allow two annual entries for the same machine', () => {
    expect(maintenanceScheduleDefinitionSchema.safeParse({ ...annual, entries: [annual.entries[0], annual.entries[0]] }).success).toBe(false);
  });
});
