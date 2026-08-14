import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolveProfile: vi.fn(),
  getForUpdate: vi.fn(),
  mute: vi.fn(),
  escalate: vi.fn(),
  insertAudit: vi.fn(),
  tx: { query: vi.fn() },
}));

vi.mock("../repository/notifications.repository", () => ({
  repoListAppNotifications: mocks.list,
  repoMarkAllAppNotificationsRead: vi.fn(),
  repoMarkAppNotificationRead: vi.fn(),
  repoGetNotificationForUpdate: mocks.getForUpdate,
  repoMuteNotification: mocks.mute,
  repoEscalateNotification: mocks.escalate,
  withNotificationTransaction: vi.fn(async (fn: (tx: typeof mocks.tx) => Promise<unknown>) => fn(mocks.tx)),
}));

vi.mock("../../access-control/services/access-control.service", () => ({
  resolveAccessProfile: mocks.resolveProfile,
}));

vi.mock("../../audit-logs/repository/audit-logs.repository", () => ({
  repoInsertAuditLog: mocks.insertAudit,
}));

import {
  svcEscalateAppNotification,
  svcListAppNotifications,
  svcMuteAppNotification,
} from "./notifications.service";

const notification = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: 9,
  kind: "commande.workflow.handoff",
  title: "Production à lancer",
  message: "Commande prête.",
  severity: "warning" as const,
  action_url: "/commandes/42",
  action_label: "Ouvrir",
  action_key: "LAUNCH_PRODUCTION",
  action_available: true,
  action_unavailable_reason: null,
  entity_type: "COMMANDE_CLIENT",
  entity_id: "42",
  module_key: "commandes-clients",
  payload: { commande_id: 42 },
  created_at: "2026-08-14T08:00:00.000Z",
  read_at: null,
  expires_at: "2026-09-14T08:00:00.000Z",
  muted_until: null,
  escalated_at: null,
  escalation_level: 0,
  state: "ACTIVE" as const,
};

const audit = {
  user_id: 9,
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/api/v1/notifications",
  client_session_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ items: [notification], total: 1, unread_total: 1, muted_total: 0, expired_total: 0 });
  mocks.resolveProfile.mockResolvedValue({
    is_superadmin: false,
    modules: [{ module_key: "commandes-clients", allowed: false }],
  });
  mocks.getForUpdate.mockResolvedValue(notification);
  mocks.mute.mockImplementation(async (_tx, params) => ({ ...notification, muted_until: params.muted_until, state: "MUTED" }));
  mocks.escalate.mockImplementation(async (_tx, params) => ({ ...notification, escalation_level: params.level }));
});

describe("SOL-25 notification work queue", () => {
  it("removes an action server-side when the recipient no longer has module access", async () => {
    const result = await svcListAppNotifications({
      user_id: 9,
      query: { unread_only: false, include_muted: false, include_expired: false, limit: 20 },
    });
    expect(result.items[0]).toMatchObject({
      action_url: null,
      action_label: null,
      action_available: false,
      action_unavailable_reason: "FORBIDDEN",
      entity_type: "COMMANDE_CLIENT",
      entity_id: "42",
    });
  });

  it("fails closed for actions when the access profile cannot be resolved", async () => {
    mocks.resolveProfile.mockResolvedValue(null);
    const result = await svcListAppNotifications({
      user_id: 9,
      query: { unread_only: false, include_muted: false, include_expired: false, limit: 20 },
    });
    expect(result.items[0]).toMatchObject({
      action_url: null,
      action_available: false,
      action_unavailable_reason: "ACCESS_UNAVAILABLE",
    });
  });

  it("audits mute and escalation without logging title, message or payload", async () => {
    const mutedUntil = new Date(Date.now() + 3_600_000).toISOString();
    await svcMuteAppNotification({
      user_id: 9,
      notification_id: notification.id,
      muted_until: mutedUntil,
      audit,
    });
    await svcEscalateAppNotification({
      user_id: 9,
      notification_id: notification.id,
      level: 1,
      audit,
    });
    expect(mocks.insertAudit).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(mocks.insertAudit.mock.calls);
    expect(serialized).not.toContain(notification.title);
    expect(serialized).not.toContain(notification.message);
    expect(serialized).not.toContain("commande_id");
  });

  it("keeps every state mutation tenant-scoped to the authenticated user", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../repository/notifications.repository.ts"),
      "utf8"
    );
    expect(source.match(/WHERE id = \$1::uuid AND user_id = \$2::int/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
