import { describe, expect, it } from 'vitest';
import { planningPreferencesBodySchema } from './planning-intelligence.validators';
const body = { timezone: 'Europe/Paris', horizon_weeks: 6, view_mode: 'WEEK', show_weekends: false, machine_ids: [], status_colors: { BLOCKED: '#FF0000' }, client_color_overrides: {} };
describe('Planning client color validation', () => {
  it.each(['#FF0000', '#A4161A', '#C1121F', '#F43F5E', '#FFAAAA', '#600000'])('rejects %s as a client color, including alternate API clients', color => {
    expect(planningPreferencesBodySchema.safeParse({ body: { ...body, client_color_overrides: { 'id:client': color } } }).success).toBe(false);
  });
  it('accepts non-red identities and preserves red for problems', () => {
    expect(planningPreferencesBodySchema.parse({ body: { ...body, client_color_overrides: { 'id:client': '#288f9c' } } }).body).toMatchObject({
      status_colors: { BLOCKED: '#FF0000' }, client_color_overrides: { 'id:client': '#288F9C' },
    });
  });
});
