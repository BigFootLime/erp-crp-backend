import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const consoleMocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  activeAccount: vi.fn(),
  isSuperadmin: vi.fn(),
}));

vi.mock("../module/admin/services/operations-console.service", () => ({
  getOperationsConsoleSnapshot: consoleMocks.snapshot,
}));

vi.mock("../module/auth/repository/auth.repository", () => ({
  findAuthenticatedAccountState: consoleMocks.activeAccount,
}));

vi.mock("../module/access-control/services/access-control.service", () => ({
  isSuperadmin: consoleMocks.isSuperadmin,
}));

import adminRoutes from "../module/admin/routes/admin.routes";
import { errorHandler } from "../middlewares/errorHandler";

const secret = "sol31-operations-console-route-secret";
const previousSecret = process.env.JWT_SECRET;
const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRoutes);
app.use(errorHandler);

function token(id = 7) {
  return jwt.sign({ id, username: "ACTOR", email: "actor@example.test", role: "Employee", session_epoch: 0 }, secret);
}

beforeAll(() => {
  process.env.JWT_SECRET = secret;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

beforeEach(() => {
  consoleMocks.snapshot.mockReset();
  consoleMocks.activeAccount.mockResolvedValue({ status: "Active", session_epoch: 0 });
  consoleMocks.isSuperadmin.mockResolvedValue(false);
});

describe("GET /api/v1/admin/operations", () => {
  it("rejects anonymous and standard users before collecting operational data", async () => {
    expect((await request(app).get("/api/v1/admin/operations")).status).toBe(401);

    const standard = await request(app)
      .get("/api/v1/admin/operations")
      .set("Authorization", `Bearer ${token()}`);
    expect(standard.status).toBe(403);
    expect(consoleMocks.snapshot).not.toHaveBeenCalled();
  });

  it("returns a no-store read-only snapshot to the live superadministrator", async () => {
    consoleMocks.isSuperadmin.mockResolvedValueOnce(true);
    consoleMocks.snapshot.mockResolvedValueOnce({
      observed_at: "2026-08-15T02:00:00.000Z",
      overall_state: "degraded",
      read_only: true,
      service: { name: "cerp-api", version: "sha", commit: "sha", environment: "test" },
      signals: [],
      alerts: [],
      links: { dashboards: null, logs: null },
      limitations: ["No repairs."],
    });

    const response = await request(app)
      .get("/api/v1/admin/operations")
      .set("Authorization", `Bearer ${token(4)}`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toMatchObject({ read_only: true, overall_state: "degraded" });
    expect(consoleMocks.snapshot).toHaveBeenCalledOnce();
  });
});
