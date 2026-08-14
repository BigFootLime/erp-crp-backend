import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/temps-deplacements/repository/temps-deplacements-operations.repository", () => ({
  repoFindActivePeriodClosure: vi.fn(),
  repoCreateAbsence: vi.fn(),
  repoGetAbsence: vi.fn(),
  repoListAbsences: vi.fn(),
  repoDecideAbsence: vi.fn(),
  repoGetClosurePreflight: vi.fn(),
  repoCreatePeriodClosure: vi.fn(),
  repoGetPeriodClosure: vi.fn(),
  repoReopenPeriodClosure: vi.fn(),
  repoListPeriodClosures: vi.fn(),
  repoGetCurrentKilometerRate: vi.fn(),
  repoCreateKilometerRate: vi.fn(),
  repoListKilometerRates: vi.fn(),
  repoGetTeamOperationsQueue: vi.fn(),
}));
vi.mock("../module/temps-deplacements/repository/temps-deplacements.repository", () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ query: vi.fn() })),
  insertAuditLog: vi.fn(async () => undefined),
  repoGetEmployeeById: vi.fn(),
}));
vi.mock("../module/temps-deplacements/services/temps-deplacements.service", () => ({
  resolveEmployeeFromUser: vi.fn(),
}));

import * as repository from "../module/temps-deplacements/repository/temps-deplacements-operations.repository";
import * as base from "../module/temps-deplacements/repository/temps-deplacements.repository";
import * as time from "../module/temps-deplacements/services/temps-deplacements.service";
import * as service from "../module/temps-deplacements/services/temps-deplacements-operations.service";
import { isHrPrivileged } from "../module/temps-deplacements/domain/temps-deplacements-policy";

const repo = vi.mocked(repository);
const EMPLOYEE = "11111111-1111-4111-8111-111111111111";
const AUDIT = { user_id: 1, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const absence = { id: "a", employee_id: EMPLOYEE, absence_date: "2026-08-14", minutes: 420, absence_type: "PAID_LEAVE" as const, timezone: "Europe/Paris", status: "REQUESTED" as const, reason: "Congé validable", source_ref: null, requested_by: 1, decided_by: null, decided_at: null, created_at: "t", updated_at: "t" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(time.resolveEmployeeFromUser).mockResolvedValue({ id: EMPLOYEE, user_id: 1, matricule: "E1", service: null, manager_user_id: 9, status: "ACTIVE" });
  repo.repoFindActivePeriodClosure.mockResolvedValue(null);
});

describe("SOL-24 absences, clôture et RBAC", () => {
  it("un accès module ordinaire ne transforme pas un employé en administrateur RH", () => {
    expect(isHrPrivileged("Employee")).toBe(false);
    expect(isHrPrivileged("Responsable RH")).toBe(true);
  });

  it("crée une absence uniquement pour l'employé du token et audite", async () => {
    repo.repoCreateAbsence.mockResolvedValue(absence);
    const result = await service.createMyAbsence({ id: 1, role: "Employee" }, {
      absence_date: "2026-08-14", minutes: 420, absence_type: "PAID_LEAVE", timezone: "Europe/Paris", reason: "Congé validable",
    }, AUDIT);
    expect(result.employee_id).toBe(EMPLOYEE);
    expect(repo.repoCreateAbsence.mock.calls[0][1].requested_by).toBe(1);
    expect(vi.mocked(base.insertAuditLog)).toHaveBeenCalled();
  });

  it("interdit toute demande dans une période clôturée", async () => {
    repo.repoFindActivePeriodClosure.mockResolvedValue({ id: "c", period_start: "2026-08-01", period_end: "2026-08-31" } as never);
    await expect(service.createMyAbsence({ id: 1, role: "Employee" }, {
      absence_date: "2026-08-14", minutes: 420, absence_type: "PAID_LEAVE", timezone: "Europe/Paris", reason: "Congé validable",
    }, AUDIT)).rejects.toMatchObject({ status: 409, code: "HR_PERIOD_CLOSED" });
  });

  it("refuse l'auto-validation d'une absence", async () => {
    repo.repoGetAbsence.mockResolvedValue(absence);
    await expect(service.decideAbsence({ id: 1, role: "Responsable RH" }, "a", "APPROVED", AUDIT))
      .rejects.toMatchObject({ status: 403, code: "HR_SELF_APPROVAL_FORBIDDEN" });
  });

  it("bloque la clôture tant que le preflight contient des exceptions", async () => {
    repo.repoGetClosurePreflight.mockResolvedValue({ unvalidated_days: 2, unvalidated_weeks: 0, unresolved_anomalies: 1, pending_adjustments: 0, pending_kilometers: 0, pending_absences: 0 });
    await expect(service.createPeriodClosure({ id: 7, role: "Responsable RH" }, {
      period_start: "2026-08-01", period_end: "2026-08-31", employee_id: null, timezone: "Europe/Paris", reason: "Clôture mensuelle",
    }, AUDIT)).rejects.toMatchObject({ status: 409, code: "HR_PERIOD_PREFLIGHT_FAILED" });
  });

  it("refuse la clôture et les taux à un utilisateur standard", async () => {
    await expect(service.createPeriodClosure({ id: 2, role: "Employee" }, {
      period_start: "2026-08-01", period_end: "2026-08-31", employee_id: null, timezone: "Europe/Paris", reason: "Clôture mensuelle",
    }, AUDIT)).rejects.toMatchObject({ status: 403, code: "HR_ADMIN_REQUIRED" });
    await expect(service.createKilometerRate({ id: 2, role: "Employee" }, {
      owner_type: "PERSONAL", rate_per_km: "0.50", currency: "EUR", effective_from: "2026-08-01",
      definition: "Barème direction", source_type: "DECLARATION", source_ref: null,
      observed_at: "2026-08-14T08:00:00.000Z", reliability: "DECLARED",
    }, AUDIT)).rejects.toMatchObject({ status: 403, code: "HR_ADMIN_REQUIRED" });
  });
});
