import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/temps-deplacements/repository/temps-deplacements-km.repository", () => ({
  repoCreateKmEntry: vi.fn(),
  repoGetKmEntryById: vi.fn(),
  repoSubmitKmEntry: vi.fn(),
  repoDecideKmEntry: vi.fn(),
  repoListKmForEmployee: vi.fn(),
  repoListTeamKmEntries: vi.fn(),
  repoListVehicles: vi.fn(),
  repoCreateVehicle: vi.fn(),
}));
vi.mock("../module/temps-deplacements/repository/temps-deplacements.repository", async (io) => {
  const actual = await io<typeof import("../module/temps-deplacements/repository/temps-deplacements.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
    insertAuditLog: vi.fn(async () => undefined),
    repoGetEmployeeById: vi.fn(),
  };
});
vi.mock("../module/temps-deplacements/services/temps-deplacements.service", async (io) => {
  const actual = await io<typeof import("../module/temps-deplacements/services/temps-deplacements.service")>();
  return { ...actual, resolveEmployeeFromUser: vi.fn() };
});

import * as kmRepo from "../module/temps-deplacements/repository/temps-deplacements-km.repository";
import * as baseRepo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import * as t2 from "../module/temps-deplacements/services/temps-deplacements.service";
import * as svc from "../module/temps-deplacements/services/temps-deplacements-km.service";
import { computeDistanceKm } from "../module/temps-deplacements/services/temps-deplacements-km.service";
import { createKmSchema } from "../module/temps-deplacements/validators/temps-deplacements.validators";

const km = vi.mocked(kmRepo);
const t2m = vi.mocked(t2);
const AUDIT = { user_id: 1, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const emp = (over = {}) => ({ id: "E", user_id: 1, matricule: "TD1", service: null, manager_user_id: null, status: "ACTIVE" as const, ...over });

beforeEach(() => vi.clearAllMocks());

describe("T6 — validateur & distance", () => {
  it("createKmSchema REFUSE employee_id (anti-IDOR) et l'odomètre incohérent", () => {
    expect(createKmSchema.parse({ date: "2026-03-02", distance_km: 12 }).distance_km).toBe(12);
    expect(() => createKmSchema.parse({ date: "2026-03-02", employee_id: "x" })).toThrow();
    expect(() => createKmSchema.parse({ date: "2026-03-02", start_odometer: 100, end_odometer: 50 })).toThrow();
  });
  it("computeDistanceKm : l'odomètre prime, sinon la distance, jamais négatif", () => {
    expect(computeDistanceKm({ start_odometer: 1000, end_odometer: 1042, distance_km: 0 })).toBe(42);
    expect(computeDistanceKm({ start_odometer: null, end_odometer: null, distance_km: 15.5 })).toBe(15.5);
    expect(computeDistanceKm({ start_odometer: null, end_odometer: null, distance_km: -3 })).toBe(0);
  });
});

describe("T6 — createMyKmEntry (anti-IDOR : employé dérivé de req.user)", () => {
  it("emploie l'employé du token, pas du corps ; audit", async () => {
    t2m.resolveEmployeeFromUser.mockResolvedValue(emp());
    km.repoCreateKmEntry.mockImplementation(async (_c, i) => ({ id: "k1", ...i, created_at: "t", validated_by: null, validated_at: null }));
    const r = await svc.createMyKmEntry({ id: 1, role: "Employee" }, { date: "2026-03-02", type: "MISSION", vehicle_id: null, start_location: null, end_location: null, start_odometer: null, end_odometer: null, distance_km: 12, affaire_id: null, client_id: null, fournisseur_id: null, submit: true }, AUDIT);
    expect(km.repoCreateKmEntry.mock.calls[0][1].employee_id).toBe("E");
    expect(r.status).toBe("SUBMITTED");
    expect(baseRepo.insertAuditLog).toHaveBeenCalled();
  });
});

describe("T6 — soumission & validation (ownership + périmètre + transitions)", () => {
  it("un salarié ne peut soumettre QUE ses déclarations → 403", async () => {
    km.repoGetKmEntryById.mockResolvedValue({ id: "k1", employee_id: "OTHER", status: "DRAFT" } as never);
    t2m.resolveEmployeeFromUser.mockResolvedValue(emp());
    await expect(svc.submitMyKmEntry({ id: 1, role: "Employee" }, "k1", AUDIT)).rejects.toMatchObject({ status: 403 });
  });
  it("soumission DRAFT→SUBMITTED ; déjà soumise → 409", async () => {
    km.repoGetKmEntryById.mockResolvedValue({ id: "k1", employee_id: "E", status: "DRAFT" } as never);
    t2m.resolveEmployeeFromUser.mockResolvedValue(emp());
    km.repoSubmitKmEntry.mockResolvedValueOnce({ id: "k1", status: "SUBMITTED" } as never);
    expect((await svc.submitMyKmEntry({ id: 1, role: "Employee" }, "k1", AUDIT)).status).toBe("SUBMITTED");
    km.repoSubmitKmEntry.mockResolvedValueOnce(null);
    await expect(svc.submitMyKmEntry({ id: 1, role: "Employee" }, "k1", AUDIT)).rejects.toMatchObject({ status: 409, code: "HR_KM_NOT_DRAFT" });
  });
  it("validation hors périmètre → 403 ; RH → VALIDATED", async () => {
    km.repoGetKmEntryById.mockResolvedValue({ id: "k1", employee_id: "E", status: "SUBMITTED" } as never);
    vi.mocked(baseRepo.repoGetEmployeeById).mockResolvedValue(emp({ manager_user_id: 99 }));
    await expect(svc.decideKmEntry({ id: 5, role: "Employee" }, "k1", "VALIDATED", AUDIT)).rejects.toMatchObject({ status: 403 });
    km.repoDecideKmEntry.mockResolvedValue({ id: "k1", status: "VALIDATED" } as never);
    expect((await svc.decideKmEntry({ id: 5, role: "Responsable RH" }, "k1", "VALIDATED", AUDIT)).status).toBe("VALIDATED");
  });
  it("valider une déclaration non soumise → 409", async () => {
    km.repoGetKmEntryById.mockResolvedValue({ id: "k1", employee_id: "E", status: "DRAFT" } as never);
    km.repoDecideKmEntry.mockResolvedValue(null);
    await expect(svc.decideKmEntry({ id: 5, role: "Responsable RH" }, "k1", "VALIDATED", AUDIT)).rejects.toMatchObject({ status: 409, code: "HR_KM_NOT_SUBMITTED" });
  });
});
