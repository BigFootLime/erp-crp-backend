import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/admin/services/admin.service", () => ({
  createAccountInvitationByAdmin: vi.fn(),
  createUserByAdmin: vi.fn(),
  getErpSetting: vi.fn(),
  listAssignableRoles: vi.fn(() => []),
  upsertDefaultShippingLocation: vi.fn(),
}));

const securityMocks = vi.hoisted(() => ({
  activeAccount: vi.fn(),
  isSuperadmin: vi.fn(),
}));

vi.mock("../module/auth/repository/auth.repository", () => ({
  findAuthenticatedAccountState: securityMocks.activeAccount,
}));

vi.mock("../module/access-control/services/access-control.service", () => ({
  isSuperadmin: securityMocks.isSuperadmin,
}));

import adminRoutes from "../module/admin/routes/admin.routes";
import * as adminService from "../module/admin/services/admin.service";
import { validationErrorMiddleware } from "../module/auth/middlewares/validationError.middleware";
import { errorHandler } from "../middlewares/errorHandler";

const secret = "admin-user-provisioning-route-test-secret";
const previousSecret = process.env.JWT_SECRET;
const idempotencyKey = "7eb84d7e-9df1-4ee7-a8e9-3ee6c85b2bee";
const createUserByAdmin = vi.mocked(adminService.createUserByAdmin);
const createInvitation = vi.mocked(adminService.createAccountInvitationByAdmin);
const getErpSetting = vi.mocked(adminService.getErpSetting);
const upsertDefaultShippingLocation = vi.mocked(adminService.upsertDefaultShippingLocation);

const app = express();
app.use(express.json());
app.use("/api/v1/admin", adminRoutes);
app.use(validationErrorMiddleware);
app.use(errorHandler);

const body = {
  username: "ATELIER.TEST",
  name: "Compte",
  surname: "Atelier",
  email: "atelier.test@example.test",
  role: "Employee",
  roles: ["Employee"],
};

function token(role: string, id = 7) {
  return jwt.sign({ id, username: "ACTOR", email: "actor@example.test", role, session_epoch: 0 }, secret);
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
  createInvitation.mockReset();
  getErpSetting.mockReset();
  upsertDefaultShippingLocation.mockReset();
  securityMocks.activeAccount.mockResolvedValue({ status: "Active", session_epoch: 0 });
  securityMocks.isSuperadmin.mockResolvedValue(false);
});

describe("ERP settings routes", () => {
  const path = "/api/v1/admin/erp-settings/stock.default_shipping_location";

  it("requires authentication and the live superadmin marker", async () => {
    expect((await request(app).get(path)).status).toBe(401);

    const forbidden = await request(app)
      .get(path)
      .set("Authorization", `Bearer ${token("Directeur")}`);
    expect(forbidden.status).toBe(403);
    expect(getErpSetting).not.toHaveBeenCalled();

    securityMocks.isSuperadmin.mockResolvedValueOnce(true);
    getErpSetting.mockResolvedValueOnce({
      key: "stock.default_shipping_location",
      value_json: null,
      value_text: null,
      updated_at: null,
    });
    const allowed = await request(app)
      .get(path)
      .set("Authorization", `Bearer ${token("Employee", 4)}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ key: "stock.default_shipping_location", value_json: null });
  });

  it("validates and forwards one coherent shipping location", async () => {
    securityMocks.isSuperadmin.mockResolvedValue(true);
    upsertDefaultShippingLocation.mockResolvedValueOnce({
      key: "stock.default_shipping_location",
      value_json: { magasin_id: "1", emplacement_id: "2" },
      value_text: null,
      updated_at: "2026-08-16T00:00:00.000Z",
    });

    const response = await request(app)
      .put(path)
      .set("Authorization", `Bearer ${token("Employee", 4)}`)
      .send({ value_json: { magasin_id: "1", emplacement_id: 2 }, value_text: null });

    expect(response.status).toBe(200);
    expect(upsertDefaultShippingLocation).toHaveBeenCalledWith({
      key: "stock.default_shipping_location",
      magasinId: "1",
      emplacementId: "2",
      actorUserId: 4,
    });
  });

  it("rejects unknown setting keys and partial payloads", async () => {
    securityMocks.isSuperadmin.mockResolvedValue(true);
    const unknown = await request(app)
      .put("/api/v1/admin/erp-settings/unknown.setting")
      .set("Authorization", `Bearer ${token("Employee", 4)}`)
      .send({ value_json: { magasin_id: "1", emplacement_id: "2" } });
    const partial = await request(app)
      .put(path)
      .set("Authorization", `Bearer ${token("Employee", 4)}`)
      .send({ value_json: { magasin_id: "1" } });

    expect(unknown.status).toBe(400);
    expect(partial.status).toBe(400);
    expect(upsertDefaultShippingLocation).not.toHaveBeenCalled();
  });
});

describe("administrative account lifecycle routes", () => {
  it("protects invitations with authentication and the live superadmin marker", async () => {
    const path = "/api/v1/admin/users/42/invitations";
    expect((await request(app).post(path).set("Idempotency-Key", idempotencyKey).send({})).status).toBe(401);

    const standard = await request(app)
      .post(path)
      .set("Authorization", `Bearer ${token("Directeur")}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({});
    expect(standard.status).toBe(403);

    securityMocks.isSuperadmin.mockResolvedValueOnce(true);
    createInvitation.mockResolvedValueOnce({
      invitation: {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: 42,
        username: "ATELIER.TEST",
        expires_at: "2099-01-01T00:00:00.000Z",
        activation_path: "/activate?token=opaque",
        token: "opaque",
      },
      replayed: false,
    });
    const admin = await request(app)
      .post(path)
      .set("Authorization", `Bearer ${token("Employee", 4)}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({});
    expect(admin.status).toBe(201);
  });

  it("retires physical account deletion from the HTTP surface", async () => {
    securityMocks.isSuperadmin.mockResolvedValueOnce(true);
    const response = await request(app)
      .delete("/api/v1/admin/users/42")
      .set("Authorization", `Bearer ${token("Employee", 4)}`);
    expect(response.status).toBe(404);
  });
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

  it("rejects role labels and allows only the live superadmin marker", async () => {
    const forbidden = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token("Employee")}`)
      .set("Idempotency-Key", idempotencyKey)
      .send(body);
    expect(forbidden.status).toBe(403);

    const director = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token("Directeur")}`)
      .set("Idempotency-Key", idempotencyKey)
      .send(body);
    expect(director.status).toBe(403);

    securityMocks.isSuperadmin.mockResolvedValueOnce(true);
    createUserByAdmin.mockResolvedValueOnce({
      user: { id: 42, role: "Employee", status: "Inactive" } as never,
      replayed: false,
    });
    const allowed = await request(app)
      .post("/api/v1/admin/users")
      .set("Authorization", `Bearer ${token("Employee", 4)}`)
      .set("Idempotency-Key", idempotencyKey)
      .send(body);
    expect(allowed.status).toBe(201);
  });

  it("returns the same resource as a replay and exposes no submitted password", async () => {
    securityMocks.isSuperadmin.mockResolvedValue(true);
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
    expect(JSON.stringify(replay.body)).not.toContain("password");
  });
});
