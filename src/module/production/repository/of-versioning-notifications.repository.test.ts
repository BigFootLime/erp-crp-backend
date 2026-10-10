import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { AppNotification } from "../../notifications/types/notifications.types";

const ports = vi.hoisted(() => ({ routing: vi.fn(), candidates: vi.fn(), create: vi.fn(), enqueue: vi.fn() }));
vi.mock("./of-versioning.repository", () => ({ readNotificationRouting: ports.routing, readNotificationCandidates: ports.candidates }));
vi.mock("../../notifications/repository/notifications.repository", () => ({ repoCreateAppNotifications: ports.create }));
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({ enqueueAppNotificationCreated: ports.enqueue }));
import { notifyVersioningTopic } from "./of-versioning-notifications.repository";

const topic = "OF_PLANNING_SUBMITTED";
const tx = { query: vi.fn() } as unknown as Pick<PoolClient, "query">;
const context = { ofId: 94, eventId: "decision-a" };
const notification = { id: "notification-7", user_id: 7 } as AppNotification;

beforeEach(() => {
  vi.resetAllMocks();
  ports.routing.mockResolvedValue([
    { topic, roleKey: "Planification", userId: null, isActive: true },
    { topic, roleKey: null, userId: 7, isActive: true },
  ]);
  ports.candidates.mockResolvedValue([
    { userId: 7, primaryRole: "Production", roles: ["PLANIFICATION"] },
    { userId: 8, primaryRole: "Qualité", roles: [] },
  ]);
  ports.create.mockResolvedValue([notification]);
  ports.enqueue.mockResolvedValue("outbox-1");
});

describe("persisted OF planning handoff", () => {
  it("persists one notification for a configured additive role and designated recipient, with an OF action", async () => {
    expect(await notifyVersioningTopic(tx, topic, "Planning soumis", context)).toEqual([7]);
    expect(ports.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tx, user_ids: [7], action_url: "/production/of/94", entity_type: "OF", entity_id: 94, module_key: "production",
      dedupe_key: "OF_PLANNING_SUBMITTED:94:decision-a",
      payload: { topic, of_id: 94, decision_id: "decision-a" },
    }));
    expect(ports.enqueue).toHaveBeenCalledExactlyOnceWith(tx, 7, notification, { deduplicationKey: "notification:notification-7" });
    expect(ports.routing).toHaveBeenCalledWith(topic, tx);
    expect(ports.candidates).toHaveBeenCalledWith(tx);
  });

  it("does not collapse two different submissions under one topic key", async () => {
    await notifyVersioningTopic(tx, topic, "v1", context);
    await notifyVersioningTopic(tx, topic, "v2", { ...context, eventId: "decision-b" });
    expect(ports.create.mock.calls.map(([input]) => input.dedupe_key)).toEqual([
      "OF_PLANNING_SUBMITTED:94:decision-a", "OF_PLANNING_SUBMITTED:94:decision-b",
    ]);
  });

  it("does not send another realtime event when the canonical repository has already persisted the decision", async () => {
    ports.create.mockResolvedValue([]);
    expect(await notifyVersioningTopic(tx, topic, "Reprise", context)).toEqual([7]);
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it("excludes a designated inactive or missing account even when routing names it", async () => {
    ports.routing.mockResolvedValue([{ topic, roleKey: null, userId: 99, isActive: true }]);
    expect(await notifyVersioningTopic(tx, topic, "Planning", context)).toEqual([]);
    expect(ports.create).not.toHaveBeenCalled();
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it("honors an unconfigured or disabled topic without a hardcoded fallback", async () => {
    ports.routing.mockResolvedValue([{ topic, roleKey: "Planification", userId: 7, isActive: false }]);
    expect(await notifyVersioningTopic(tx, topic, "Planning", context)).toEqual([]);
    expect(ports.create).not.toHaveBeenCalled();
  });

  it("propagates notification failure so the owning decision cannot be committed without its handoff", async () => {
    ports.create.mockRejectedValue(Error("notification write failed"));
    await expect(notifyVersioningTopic(tx, topic, "Planning", context)).rejects.toThrow("notification write failed");
    expect(ports.enqueue).not.toHaveBeenCalled();
  });

  it("propagates outbox failure to the same owning transaction", async () => {
    ports.enqueue.mockRejectedValue(Error("outbox write failed"));
    await expect(notifyVersioningTopic(tx, topic, "Planning", context)).rejects.toThrow("outbox write failed");
  });
});
