import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isSuperadmin: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const id = Number(req.header("x-test-user-id"));
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(401).json({ error: "Token manquant ou invalide" });
    req.user = { id, username: "test", email: "test@example.invalid", role: "Employee" };
    next();
  },
}));

vi.mock("../module/access-control/services/access-control.service", () => ({
  isSuperadmin: (...args: unknown[]) => mocks.isSuperadmin(...args),
}));

vi.mock("../module/integrations/webhooks/webhook.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/integrations/webhooks/webhook.service")>();
  return {
    ...actual,
    createWebhookSubscription: (...args: unknown[]) => mocks.create(...args),
    listWebhookSubscriptions: (...args: unknown[]) => mocks.list(...args),
  };
});

import { errorHandler } from "../middlewares/errorHandler";
import routes from "../module/integrations/webhooks/webhook.routes";

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/admin/webhooks", routes);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.list.mockResolvedValue([]);
});

describe("SOL-28 webhook administration RBAC", () => {
  it("rejects an anonymous caller before the service", async () => {
    expect((await request(app()).get("/admin/webhooks/subscriptions")).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("rejects a standard authenticated account using the live superadmin decision", async () => {
    mocks.isSuperadmin.mockResolvedValue(false);
    const response = await request(app()).get("/admin/webhooks/subscriptions").set("x-test-user-id", "12");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Accès interdit" });
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("allows the superadmin but requires an idempotency UUID for creation", async () => {
    mocks.isSuperadmin.mockResolvedValue(true);
    const response = await request(app())
      .post("/admin/webhooks/subscriptions")
      .set("x-test-user-id", "4")
      .send({ name: "Cabinet", endpoint_url: "https://example.com/hook", event_types: ["erp.invoice.issued.v1"] });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns the same contract on an exact idempotent replay", async () => {
    mocks.isSuperadmin.mockResolvedValue(true);
    mocks.create.mockResolvedValue({
      subscription: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Cabinet",
        endpoint_url: "https://example.com/hook",
        event_types: ["erp.invoice.issued.v1"],
        status: "ACTIVE",
        secret_hint: "ret_once",
        secret_version: 1,
        consecutive_failure_count: 0,
        disabled_reason: null,
        created_at: "2026-08-14T10:00:00.000Z",
        updated_at: "2026-08-14T10:00:00.000Z",
      },
      secret: "whsec_once",
      idempotent_replay: true,
    });
    const response = await request(app())
      .post("/admin/webhooks/subscriptions")
      .set("x-test-user-id", "4")
      .set("Idempotency-Key", "22222222-2222-4222-8222-222222222222")
      .send({ name: "Cabinet", endpoint_url: "https://example.com/hook", event_types: ["erp.invoice.issued.v1"] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.idempotent_replay).toBe(true);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "22222222-2222-4222-8222-222222222222" }));
  });
});
