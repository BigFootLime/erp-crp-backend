import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/admin/services/admin.service", () => ({
  createUserByAdmin: vi.fn(),
  listAssignableRoles: vi.fn(() => []),
}));

import adminRoutes from "../module/admin/routes/admin.routes";
import * as adminService from "../module/admin/services/admin.service";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import { errorHandler } from "../middlewares/errorHandler";

const secret = "admin-user-provisioning-route-test-secret";
const previousSecret = process.env.JWT_SECRET;
const idempotencyKey = "7eb84d7e-9df1-4ee7-a8e9-3ee6c85b2bee";
const createUserByAdmin = vi.mocked(adminService.createUserByAdmin);

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRoutes);
app.use(validationErrorMiddleware);
app.use(errorHandler);

const body = {
  username: "ATELIER.TEST",
  password: "P@ssword12",
  name: "Compte",
  surname: "Atelier",
  email: "atelier.test@example.test",
  role: "Employee",
  roles: ["Employee"],
};

function token(role: string) {
  return jwt.sign({ id: 7, username: "ACTOR", email: "actor@example.test", role }, secret);
}

beforeAll(() => {
  process.env.JWT_SECRET = secret;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});

beforeEach(() => {
  createUserByAdmin.mockReset();
});

describe("POST /api/v1/admin/users", () => {
  it("requires authentication", async () => {
    const response = await request(app)
      .post("/api/v1/admin/users")
      .set("Idempotency-Key", idempotencyKey)
      .send(body);

    expect(response.status).toBe(401);
    expect(createUserByAdmin).not.toHaveBeenCalled();
  });

  it("rejects Employee and allows both administrative roles", async () => {
    const forbidden = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token("Employee")}`)
      .set("Idempotency-Key", idempotencyKey)
      .send(body);
    expect(forbidden.status).toBe(403);

    for (const role of ["Administrateur Systeme et Reseau", "Directeur"]) {
      createUserByAdmin.mockResolvedValueOnce({
        user: { id: 42, role: "Employee", status: "Inactive" } as never,
        replayed: false,
      });
      const allowed = await request(app)
        .post("/api/v1/admin/users")
        .set("Authorization", `Bearer ${token(role)}`)
        .set("Idempotency-Key", idempotencyKey)
        .send(body);
      expect(allowed.status, role).toBe(201);
    }
  });

  it("returns the same resource as a replay and exposes no submitted password", async () => {
    createUserByAdmin
      .mockResolvedValueOnce({
        user: { id: 42, role: "Employee", status: "Inactive" } as never,
        replayed: false,
      })
      .mockResolvedValueOnce({
        user: { id: 42, role: "Employee", status: "Inactive" } as never,
        replayed: true,
      });

    const headers = {
      Authorization: `Bearer ${token("Directeur")}`,
      "Idempotency-Key": idempotencyKey,
    };
    const first = await request(app).post("/api/v1/admin/users").set(headers).send(body);
    const replay = await request(app).post("/api/v1/admin/users").set(headers).send(body);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body.user.id).toBe(first.body.user.id);
    expect(JSON.stringify(replay.body)).not.toContain(body.password);
  });
});
