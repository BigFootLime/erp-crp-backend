import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { AppNotification } from '../../notifications/types/notifications.types';

const ports = vi.hoisted(() => ({ create: vi.fn(), enqueue: vi.fn() }));
vi.mock('../../notifications/repository/notifications.repository', () => ({ repoCreateAppNotifications: ports.create }));
vi.mock('../../../shared/realtime/realtime-outbox.service', () => ({ enqueueAppNotificationCreated: ports.enqueue }));
import { notifyReplenishmentPlanning } from './production-replenishment-notifications.repository';

const topic = 'OF_REPLENISHMENT_CREATED';
const fallback = 'OF_PLANNING_SUBMITTED';
function fixture() {
  const rules = [{ topic, role_key: 'Planification', user_id: null as number | null, is_active: true }];
  const users = [{ user_id: 7, primary_role: 'Production', roles: ['PLANIFICATION'] },
    { user_id: 8, primary_role: 'Secrétariat', roles: [] }];
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM public.notification_routing')) return { rows: rules };
    if (sql.includes('FROM public.users')) return { rows: users };
    throw Error('Unexpected query');
  });
  const tx = { query } as unknown as Pick<PoolClient, 'query'>;
  const input = { launchId: 'launch-1', contractId: 'contract-1', clientId: '195',
    roots: [{ root_of_id: 101, number: 'OF-2026-101', quantity: '40', target_date: '2026-09-30', target_overdue: true }] };
  const notification: AppNotification = { id: 'notification-7', user_id: 7, kind: 'production.replenishment.created',
    title: 'OF-2026-101 à préparer', message: '40 pièces', severity: 'warning', action_url: '/production/of/101', action_label: 'Ouvrir',
    action_key: 'PREPARE_OF', action_available: true, action_unavailable_reason: null, entity_type: 'OF', entity_id: '101',
    module_key: 'production', payload: {}, created_at: '2026-10-10T07:00:00Z', read_at: null, expires_at: null, muted_until: null,
    escalated_at: null, escalation_level: 0, state: 'ACTIVE' };
  ports.create.mockResolvedValue([notification]); ports.enqueue.mockResolvedValue('outbox-1');
  return { tx, query, input, rules, users, notification };
}
beforeEach(() => vi.resetAllMocks());

describe('anticipated production handoff', () => {
  it('resolves additive planner roles and deduplicates an explicitly designated active recipient', async () => {
    const f = fixture(); f.rules.push({ topic, role_key: '', user_id: 7, is_active: true });
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 1, notifications: 1 });
    expect(ports.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tx: f.tx, user_ids: [7],
      action_url: '/production/of/101', module_key: 'production', severity: 'warning',
      dedupe_key: 'OF_REPLENISHMENT_CREATED:launch-1:101',
      payload: expect.objectContaining({ target_date: '2026-09-30', target_overdue: true, contract_id: 'contract-1' }) }));
    expect(ports.enqueue).toHaveBeenCalledExactlyOnceWith(f.tx, 7, f.notification, { deduplicationKey: 'notification:notification-7' });
  });

  it('uses the configured existing planner topic when the new topic has no rules', async () => {
    const f = fixture(); f.rules[0].topic = fallback;
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 1, notifications: 1 });
    expect(ports.create).toHaveBeenCalledWith(expect.objectContaining({ user_ids: [7] }));
  });

  it('honors an explicitly disabled new topic instead of restoring its fallback recipients', async () => {
    const f = fixture(); f.rules[0].is_active = false;
    f.rules.push({ topic: fallback, role_key: 'Planification', user_id: null, is_active: true });
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 0, notifications: 0 });
    expect(f.query).toHaveBeenCalledTimes(1); expect(ports.create).not.toHaveBeenCalled();
  });

  it('uses only the new routing when configured and excludes a designated inactive or missing user', async () => {
    const f = fixture(); f.rules[0] = { topic, role_key: '', user_id: 99, is_active: true };
    f.rules.push({ topic: fallback, role_key: 'Planification', user_id: null, is_active: true });
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 0, notifications: 0 });
    expect(ports.create).not.toHaveBeenCalled();
    expect(f.query.mock.calls[1][0]).toContain("NOT IN ('inactive','blocked','suspended')");
  });

  it('does not silently route an unconfigured topic to every account', async () => {
    const f = fixture(); f.rules.length = 0;
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 0, notifications: 0 });
    expect(ports.create).not.toHaveBeenCalled(); expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it('does not emit another realtime reward when a persisted dedupe key already exists', async () => {
    const f = fixture(); ports.create.mockResolvedValue([]);
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 1, notifications: 0 });
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it('fails the owning generation transaction if notification persistence fails', async () => {
    const f = fixture(); ports.create.mockRejectedValue(Error('notification write failed'));
    await expect(notifyReplenishmentPlanning(f.tx, f.input)).rejects.toThrow('notification write failed');
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it('fails the owning generation transaction if its realtime delivery cannot be persisted', async () => {
    const f = fixture(); ports.enqueue.mockRejectedValue(Error('outbox write failed'));
    await expect(notifyReplenishmentPlanning(f.tx, f.input)).rejects.toThrow('outbox write failed');
  });

  it('does not consult recipients for an empty launch', async () => {
    const f = fixture(); f.input.roots = [];
    expect(await notifyReplenishmentPlanning(f.tx, f.input)).toEqual({ recipients: 0, notifications: 0 });
    expect(f.query).not.toHaveBeenCalled();
  });
});
