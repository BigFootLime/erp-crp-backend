import { describe, expect, it } from 'vitest';
import { stationCalendarDate } from './station-calendar-date';

describe('station calendar dates', () => {
  it.each(['2026-10-16','2024-02-29','2026-12-31','2027-01-01'])('preserves valid date %s', date => {
    expect(stationCalendarDate(date)).toBe(date);
  });
  it('preserves the pg local-midnight DATE rather than serializing it as an instant', () => {
    expect(stationCalendarDate(new Date(2026, 9, 16))).toBe('2026-10-16');
    expect(stationCalendarDate(new Date(2027, 0, 1))).toBe('2027-01-01');
  });
  it.each([null,undefined,new Date(NaN),'2026-02-29','2026-02-31','2026-13-01',
    '2026-10-00','0000-01-01','16/10/2026','Fri Oct 16','2026-10-16T00:00:00Z',2001,{}])
    ('does not invent a calendar date from %s', value => {
      expect(stationCalendarDate(value)).toBeNull();
    });
});
