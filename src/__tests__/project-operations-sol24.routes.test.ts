import { EventEmitter } from "events";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../utils/httpError";

const mocks = vi.hoisted(() => ({
  currentRole: { value: "Responsable RH" as string | null },
  projectOperations: vi.fn(),
  createBudget: vi.fn(),
  createAbsence: vi.fn(),
  createClosure: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();
  const pool = { on: emitter.on.bind(emitter), query: vi.fn(), connect: vi.fn() };
  return { Pool: vi.fn(() => pool), __emitter__: emitter };
});
vi.mock("../utils/checkNetworkDrive", () => ({ checkNetworkDrive: vi.fn(() => Promise.resolve()) }));
vi.mock("../module/access-control/middlewares/module-access-gate", () => ({
  moduleAccessGate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/project-office/middlewares/require-project-office-access", () => ({
  requireProjectOfficeAccess: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (
    req: { user?: { id: number; username: string; email: string; role: string; primary_role: string; roles: string[] } },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (mocks.currentRole.value === null) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    req.user = {
      id: 17,
      username: "sol24-test",
      email: "sol24@test.invalid",
      role: mocks.currentRole.value,
      primary_role: mocks.currentRole.value,
      roles: [mocks.currentRole.value],
    };
    next();
  },
  authorizeRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../module/project-office/services/project-office-operations.service", () => ({
  getProjectOperations: mocks.projectOperations,
  createProjectBudget: mocks.createBudget,
  linkProjectAffaire: vi.fn(),
  unlinkProjectAffaire: vi.fn(),
}));
vi.mock("../module/temps-deplacements/services/temps-deplacements-operations.service", () => ({
  createMyAbsence: mocks.createAbsence,
  listMyAbsences: vi.fn(async () => []),
  listTeamAbsences: vi.fn(async () => []),
  decideAbsence: vi.fn(),
  getOperationsQueue: vi.fn(async () => ({ generated_at: "2026-08-14T08:00:00.000Z" })),
  listClosures: vi.fn(async () => []),
  createPeriodClosure: mocks.createClosure,
  reopenPeriodClosure: vi.fn(),
  listKilometerRates: vi.fn(async () => []),
  createKilometerRate: vi.fn(),
}));

import app from "../config/app";

const PROJECT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentRole.value = "Responsable RH";
  mocks.projectOperations.mockResolvedValue({ generated_at: "2026-08-14T08:00:00.000Z", data_quality: [] });
  mocks.createBudget.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" });
  mocks.createAbsence.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", status: "REQUESTED" });
  mocks.createClosure.mockImplementation(async (actor: { role: string }) => {
    if (actor.role === "Employee") throw new HttpError(403, "HR_ADMIN_REQUIRED", "Action réservée à l'administration RH.");
    return { closure: { id: "44444444-4444-4444-8444-444444444444" }, preflight: {} };
  });
});

describe("SOL-24 route contracts and RBAC", () => {
  it("refuse les nouveaux contrats à un appel anonyme", async () => {
    mocks.currentRole.value = null;
    expect((await request(app).get(`/api/v1/project-office/projects/${PROJECT}/operations`)).status).toBe(401);
    expect((await request(app).get("/api/v1/time-clock/team/operations-queue")).status).toBe(401);
  });

  it("expose le pilotage projet à un membre authentifié et valide le budget avant service", async () => {
    expect((await request(app).get(`/api/v1/project-office/projects/${PROJECT}/operations`)).status).toBe(200);
    const invalid = await request(app).post(`/api/v1/project-office/projects/${PROJECT}/budget-versions`).send({ amount: "10" });
    expect(invalid.status).toBe(400);
    expect(mocks.createBudget).not.toHaveBeenCalled();
  });

  it("dérive l'auteur d'une absence du JWT et refuse tout employee_id injecté", async () => {
    mocks.currentRole.value = "Employee";
    const injected = await request(app).post("/api/v1/time-clock/absences").send({
      employee_id: "99999999-9999-4999-8999-999999999999",
      absence_date: "2026-08-20",
      minutes: 420,
      absence_type: "PAID_LEAVE",
      timezone: "Europe/Paris",
      reason: "Congé planifié",
    });
    expect(injected.status).toBe(400);
    expect(mocks.createAbsence).not.toHaveBeenCalled();

    const response = await request(app).post("/api/v1/time-clock/absences").send({
      absence_date: "2026-08-20",
      minutes: 420,
      absence_type: "PAID_LEAVE",
      timezone: "Europe/Paris",
      reason: "Congé planifié",
    });
    expect(response.status).toBe(201);
    expect(mocks.createAbsence).toHaveBeenCalledWith(
      expect.objectContaining({ id: 17, role: "Employee" }),
      expect.not.objectContaining({ employee_id: expect.anything() }),
      expect.anything(),
    );
  });

  it("réserve la clôture de période à l'administration RH", async () => {
    mocks.currentRole.value = "Employee";
    const response = await request(app).post("/api/v1/time-clock/admin/period-closures").send({
      period_start: "2026-08-01",
      period_end: "2026-08-31",
      timezone: "Europe/Paris",
      reason: "Clôture mensuelle validée",
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("HR_ADMIN_REQUIRED");
  });
});
