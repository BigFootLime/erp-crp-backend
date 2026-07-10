import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/temps-deplacements/repository/temps-deplacements-devices.repository", () => ({
  repoCreateDevice: vi.fn(),
  repoListDevices: vi.fn(),
  repoSetDeviceStatus: vi.fn(),
  repoRotateDeviceToken: vi.fn(),
  repoCreateBadge: vi.fn(),
  repoListBadges: vi.fn(),
  repoRevokeBadge: vi.fn(),
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

import * as devRepo from "../module/temps-deplacements/repository/temps-deplacements-devices.repository";
import * as baseRepo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import * as svc from "../module/temps-deplacements/services/temps-deplacements-devices.service";
import { hashBadgeUid, hashDeviceToken } from "../module/temps-deplacements/services/temps-deplacements.service";

const dev = vi.mocked(devRepo);
const base = vi.mocked(baseRepo);
const AUDIT = { user_id: 9, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const RH = { id: 9, role: "Responsable RH" };
const SALARIE = { id: 2, role: "Employee" };
const EMP_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => vi.clearAllMocks());

describe("T8 — bornes : token généré, haché, jamais loggé", () => {
  it("createDevice renvoie un token en clair 1×, stocke le HASH, audit sans secret", async () => {
    dev.repoCreateDevice.mockImplementation(async (_c, i) => ({ id: "d1", name: i.name, location: i.location, device_type: i.device_type, status: "ACTIVE", last_seen_at: null, created_at: "t" }));
    const r = await svc.createDevice(RH, { name: "Borne Atelier", location: "Hall", device_type: "KIOSK" }, AUDIT);
    expect(r.token).toMatch(/^[0-9a-f]{48}$/);
    // Le hash stocké correspond bien au token renvoyé.
    expect(dev.repoCreateDevice.mock.calls[0][1].device_token_hash).toBe(hashDeviceToken(r.token));
    // La réponse device n'expose PAS le hash.
    expect(r.device).not.toHaveProperty("device_token_hash");
    // L'audit ne contient JAMAIS le token.
    const auditDetails = base.insertAuditLog.mock.calls[0][2].details as Record<string, unknown>;
    expect(JSON.stringify(auditDetails)).not.toContain(r.token);
    expect(auditDetails).toEqual({ name: "Borne Atelier" });
  });
  it("un salarié ne peut PAS créer de borne → 403", async () => {
    await expect(svc.createDevice(SALARIE, { name: "X", location: null, device_type: null }, AUDIT)).rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
    expect(dev.repoCreateDevice).not.toHaveBeenCalled();
  });
  it("changer le statut d'une borne inexistante → 404", async () => {
    dev.repoSetDeviceStatus.mockResolvedValue(null);
    await expect(svc.setDeviceStatus(RH, EMP_ID, "DISABLED", AUDIT)).rejects.toMatchObject({ status: 404, code: "HR_DEVICE_NOT_FOUND" });
  });
});

describe("T8 — badges : uid haché, jamais loggé", () => {
  it("createBadge stocke le HASH de l'uid, audit sans uid", async () => {
    base.repoGetEmployeeById.mockResolvedValue({ id: EMP_ID, user_id: 1, matricule: "TD1", service: null, manager_user_id: null, status: "ACTIVE" });
    dev.repoCreateBadge.mockImplementation(async (_c, i) => ({ id: "b1", employee_id: i.employee_id, badge_label: i.badge_label, active: true, issued_at: "t", revoked_at: null }));
    await svc.createBadge(RH, { employee_id: EMP_ID, badge_uid: "04AABBCCDD", badge_label: "Badge 1" }, AUDIT);
    expect(dev.repoCreateBadge.mock.calls[0][1].badge_uid_hash).toBe(hashBadgeUid("04AABBCCDD"));
    const auditDetails = base.insertAuditLog.mock.calls[0][2].details as Record<string, unknown>;
    expect(JSON.stringify(auditDetails)).not.toContain("04AABBCCDD");
  });
  it("badge pour un employé inexistant → 404", async () => {
    base.repoGetEmployeeById.mockResolvedValue(null);
    await expect(svc.createBadge(RH, { employee_id: EMP_ID, badge_uid: "x", badge_label: null }, AUDIT)).rejects.toMatchObject({ status: 404 });
  });
  it("un salarié ne peut PAS créer de badge → 403", async () => {
    await expect(svc.createBadge(SALARIE, { employee_id: EMP_ID, badge_uid: "x", badge_label: null }, AUDIT)).rejects.toMatchObject({ status: 403 });
  });
  it("révoquer un badge déjà révoqué → 409", async () => {
    dev.repoRevokeBadge.mockResolvedValue(null);
    await expect(svc.revokeBadge(RH, EMP_ID, AUDIT)).rejects.toMatchObject({ status: 409, code: "HR_BADGE_NOT_ACTIVE" });
  });
});
