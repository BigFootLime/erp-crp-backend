import { beforeEach, describe, expect, it, vi } from "vitest";

// Repository corrections : entièrement mocké (pas de DB en test unitaire).
vi.mock("../module/temps-deplacements/repository/temps-deplacements-corrections.repository", () => ({
  repoResolveTargetEmployeeId: vi.fn(),
  repoCreateAdjustment: vi.fn(),
  repoGetAdjustmentById: vi.fn(),
  repoDecideAdjustment: vi.fn(),
  repoGetTimesheetDayById: vi.fn(),
  repoGetTimesheetWeekById: vi.fn(),
  repoSetDayValidation: vi.fn(),
  repoSetWeekValidation: vi.fn(),
  repoListTeamAdjustments: vi.fn(),
  repoListTeamAnomaliesForDate: vi.fn(),
  repoListTeamEmployees: vi.fn(),
}));

// Repository T2 : on garde le réel SAUF transaction/audit/lecture employé (pour ne pas toucher la DB).
vi.mock("../module/temps-deplacements/repository/temps-deplacements.repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../module/temps-deplacements/repository/temps-deplacements.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
    insertAuditLog: vi.fn(async () => undefined),
    repoGetEmployeeById: vi.fn(),
  };
});

import * as corRepo from "../module/temps-deplacements/repository/temps-deplacements-corrections.repository";
import * as baseRepo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import * as svc from "../module/temps-deplacements/services/temps-deplacements-corrections.service";
import {
  createAdjustmentSchema,
  uuidParamsSchema,
} from "../module/temps-deplacements/validators/temps-deplacements.validators";
import type { HrEmployeeLite } from "../module/temps-deplacements/types/temps-deplacements.types";

const cor = vi.mocked(corRepo);
const base = vi.mocked(baseRepo);

const UUID = "22222222-2222-4222-8222-222222222222";
const AUDIT = {
  user_id: 1, ip: null, user_agent: null, device_type: null, os: null, browser: null,
  path: null, page_key: null, client_session_id: null,
};
const emp = (over: Partial<HrEmployeeLite> = {}): HrEmployeeLite => ({
  id: "11111111-1111-4111-8111-111111111111",
  user_id: 1, matricule: "TD001", service: null, manager_user_id: null, status: "ACTIVE", ...over,
});
const adj = (over: Partial<Awaited<ReturnType<typeof corRepo.repoGetAdjustmentById>>> = {}) => ({
  id: UUID, target_type: "DAY" as const, target_id: UUID, reason: "oubli de badge",
  status: "REQUESTED" as const, requested_by: 1, approved_by: null, created_at: "t", approved_at: null, ...over,
});

beforeEach(() => vi.clearAllMocks());

describe("T4 — validateurs corrections", () => {
  it("createAdjustmentSchema : motif obligatoire, strict, enum cible", () => {
    expect(createAdjustmentSchema.parse({ target_type: "DAY", target_id: UUID, reason: "oubli" }).reason).toBe("oubli");
    expect(() => createAdjustmentSchema.parse({ target_type: "DAY", target_id: UUID, reason: "x" })).toThrow(); // <3
    expect(() => createAdjustmentSchema.parse({ target_type: "NOPE", target_id: UUID, reason: "oubli" })).toThrow();
    expect(() => createAdjustmentSchema.parse({ target_type: "DAY", target_id: UUID, reason: "oubli", employee_id: 3 })).toThrow(); // strict
  });
  it("uuidParamsSchema : refuse un id non-uuid", () => {
    expect(uuidParamsSchema.parse({ id: UUID }).id).toBe(UUID);
    expect(() => uuidParamsSchema.parse({ id: "42" })).toThrow();
  });
});

describe("T4 — isHrPrivileged", () => {
  it("RH / Direction / Admin privilégiés ; salarié non", () => {
    expect(svc.isHrPrivileged("Responsable RH")).toBe(true);
    expect(svc.isHrPrivileged("Direction")).toBe(true);
    expect(svc.isHrPrivileged("Administrateur")).toBe(true);
    expect(svc.isHrPrivileged("Employee")).toBe(false);
  });
});

describe("T4 — createAdjustment (anti-IDOR, motif tracé)", () => {
  it("cible inexistante → 404", async () => {
    cor.repoResolveTargetEmployeeId.mockResolvedValue(null);
    await expect(svc.createAdjustment({ id: 1, role: "Employee" }, { target_type: "DAY", target_id: UUID, reason: "oubli" }, AUDIT))
      .rejects.toMatchObject({ status: 404, code: "HR_TARGET_NOT_FOUND" });
  });
  it("un salarié ne peut PAS demander une correction sur autrui → 403", async () => {
    cor.repoResolveTargetEmployeeId.mockResolvedValue("emp-x");
    base.repoGetEmployeeById.mockResolvedValue(emp({ user_id: 1, manager_user_id: 9 }));
    await expect(svc.createAdjustment({ id: 2, role: "Employee" }, { target_type: "DAY", target_id: UUID, reason: "oubli" }, AUDIT))
      .rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
  });
  it("sur SES données → créée en REQUESTED + audit 'requested'", async () => {
    cor.repoResolveTargetEmployeeId.mockResolvedValue("emp-self");
    base.repoGetEmployeeById.mockResolvedValue(emp({ user_id: 2 }));
    cor.repoCreateAdjustment.mockResolvedValue(adj({ requested_by: 2 }));
    const r = await svc.createAdjustment({ id: 2, role: "Employee" }, { target_type: "DAY", target_id: UUID, reason: "oubli de badge" }, AUDIT);
    expect(r.status).toBe("REQUESTED");
    expect(base.insertAuditLog).toHaveBeenCalledWith(expect.anything(), AUDIT, expect.objectContaining({ action: "temps-deplacements.adjustment.requested" }));
  });
});

describe("T4 — decideAdjustment (pas d'auto-validation, RBAC, idempotence)", () => {
  it("demande inexistante → 404", async () => {
    cor.repoGetAdjustmentById.mockResolvedValue(null);
    await expect(svc.decideAdjustment({ id: 5, role: "Responsable RH" }, UUID, "APPROVED", AUDIT))
      .rejects.toMatchObject({ status: 404, code: "HR_ADJUSTMENT_NOT_FOUND" });
  });
  it("demande déjà traitée → 409", async () => {
    cor.repoGetAdjustmentById.mockResolvedValue(adj({ status: "APPROVED" }));
    await expect(svc.decideAdjustment({ id: 5, role: "Responsable RH" }, UUID, "APPROVED", AUDIT))
      .rejects.toMatchObject({ status: 409, code: "HR_ADJUSTMENT_NOT_PENDING" });
  });
  it("AUTO-VALIDATION interdite : le demandeur ne peut approuver sa propre demande → 403", async () => {
    cor.repoGetAdjustmentById.mockResolvedValue(adj({ requested_by: 7 }));
    await expect(svc.decideAdjustment({ id: 7, role: "Responsable RH" }, UUID, "APPROVED", AUDIT))
      .rejects.toMatchObject({ status: 403, code: "HR_SELF_APPROVAL_FORBIDDEN" });
  });
  it("hors périmètre (ni manager ni RH) → 403", async () => {
    cor.repoGetAdjustmentById.mockResolvedValue(adj({ requested_by: 1 }));
    cor.repoResolveTargetEmployeeId.mockResolvedValue("emp-x");
    base.repoGetEmployeeById.mockResolvedValue(emp({ manager_user_id: 99 }));
    await expect(svc.decideAdjustment({ id: 5, role: "Employee" }, UUID, "APPROVED", AUDIT))
      .rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
  });
  it("responsable RH approuve → APPROVED + audit 'approved'", async () => {
    cor.repoGetAdjustmentById.mockResolvedValue(adj({ requested_by: 1 }));
    cor.repoResolveTargetEmployeeId.mockResolvedValue("emp-x");
    cor.repoDecideAdjustment.mockResolvedValue(adj({ status: "APPROVED", requested_by: 1, approved_by: 5 }));
    const r = await svc.decideAdjustment({ id: 5, role: "Responsable RH" }, UUID, "APPROVED", AUDIT);
    expect(r.status).toBe("APPROVED");
    expect(base.insertAuditLog).toHaveBeenCalledWith(expect.anything(), AUDIT, expect.objectContaining({ action: "temps-deplacements.adjustment.approved" }));
  });
  it("course : la transition a déjà eu lieu (repo renvoie null) → 409", async () => {
    cor.repoGetAdjustmentById.mockResolvedValue(adj({ requested_by: 1 }));
    cor.repoResolveTargetEmployeeId.mockResolvedValue("emp-x");
    cor.repoDecideAdjustment.mockResolvedValue(null);
    await expect(svc.decideAdjustment({ id: 5, role: "Responsable RH" }, UUID, "APPROVED", AUDIT))
      .rejects.toMatchObject({ status: 409, code: "HR_ADJUSTMENT_NOT_PENDING" });
  });
});

describe("T4 — validateTimesheetDay", () => {
  it("journée inexistante → 404", async () => {
    cor.repoGetTimesheetDayById.mockResolvedValue(null);
    await expect(svc.validateTimesheetDay({ id: 5, role: "Responsable RH" }, UUID, AUDIT))
      .rejects.toMatchObject({ status: 404, code: "HR_TIMESHEET_NOT_FOUND" });
  });
  it("journée déjà validée → 409 (non rejouable)", async () => {
    cor.repoGetTimesheetDayById.mockResolvedValue({ id: UUID, employee_id: "emp-x", validation_status: "VALIDATED" });
    await expect(svc.validateTimesheetDay({ id: 5, role: "Responsable RH" }, UUID, AUDIT))
      .rejects.toMatchObject({ status: 409, code: "HR_ALREADY_VALIDATED" });
  });
  it("DRAFT → VALIDATED + audit 'day.validated'", async () => {
    cor.repoGetTimesheetDayById.mockResolvedValue({ id: UUID, employee_id: "emp-x", validation_status: "DRAFT" });
    cor.repoSetDayValidation.mockResolvedValue({ id: UUID, employee_id: "emp-x", validation_status: "VALIDATED" });
    const r = await svc.validateTimesheetDay({ id: 5, role: "Responsable RH" }, UUID, AUDIT);
    expect(r.validation_status).toBe("VALIDATED");
    expect(base.insertAuditLog).toHaveBeenCalledWith(expect.anything(), AUDIT, expect.objectContaining({ action: "temps-deplacements.day.validated" }));
  });
});
