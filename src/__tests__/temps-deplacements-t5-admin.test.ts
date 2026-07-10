import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/temps-deplacements/repository/temps-deplacements-rules.repository", () => ({
  repoListRuleSets: vi.fn(),
  repoInsertRuleSet: vi.fn(),
  repoUpdateRuleSet: vi.fn(),
  repoSetRuleSetActive: vi.fn(),
  repoGetRuleSetById: vi.fn(),
  repoListContracts: vi.fn(),
  repoGetContractById: vi.fn(),
  repoInsertContract: vi.fn(),
  repoUpdateContract: vi.fn(),
  repoSetContractActive: vi.fn(),
  repoListSchedules: vi.fn(),
  repoInsertSchedule: vi.fn(),
  repoUpdateSchedule: vi.fn(),
  repoDeleteSchedule: vi.fn(),
}));
vi.mock("../module/temps-deplacements/repository/temps-deplacements.repository", async (io) => {
  const actual = await io<typeof import("../module/temps-deplacements/repository/temps-deplacements.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
    insertAuditLog: vi.fn(async () => undefined),
  };
});

import * as rulesRepo from "../module/temps-deplacements/repository/temps-deplacements-rules.repository";
import * as baseRepo from "../module/temps-deplacements/repository/temps-deplacements.repository";
import * as admin from "../module/temps-deplacements/services/temps-deplacements-admin.service";

const rules = vi.mocked(rulesRepo);
const base = vi.mocked(baseRepo);
const AUDIT = { user_id: 9, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const RH = { id: 9, role: "Responsable RH" };
const SALARIE = { id: 2, role: "Employee" };
const RULE = {
  name: "Cadre 35h", weekly_target_minutes: 2100, daily_target_minutes: 420,
  overtime_threshold_1_minutes: 2100, overtime_rate_1: 1.25, overtime_threshold_2_minutes: 2580, overtime_rate_2: 1.5,
  rounding_rule: {}, break_rule: {},
};
const CONTRACT = {
  employee_id: "11111111-1111-4111-8111-111111111111", contract_type: "H35" as const,
  weekly_hours_target: 35, daily_hours_target: null, start_date: "2026-01-01", end_date: null, rule_set_id: null, active: true,
};

beforeEach(() => vi.clearAllMocks());

describe("T5 — admin RH : Responsable RH autorisé", () => {
  it("crée une règle + audit", async () => {
    rules.repoInsertRuleSet.mockResolvedValue({ id: "rs1", ...RULE });
    const r = await admin.createRuleSet(RH, RULE, AUDIT);
    expect(r.id).toBe("rs1");
    expect(rules.repoInsertRuleSet).toHaveBeenCalledOnce();
    expect(base.insertAuditLog).toHaveBeenCalledWith(expect.anything(), AUDIT, expect.objectContaining({ action: "temps-deplacements.rule_set.create" }));
  });
  it("crée un contrat", async () => {
    rules.repoInsertContract.mockResolvedValue({ id: "c1", ...CONTRACT });
    const r = await admin.createContract(RH, CONTRACT, AUDIT);
    expect(r.id).toBe("c1");
  });
});

describe("T5 — admin RH : anti-IDOR (salarié refusé)", () => {
  it("un salarié ne peut PAS créer de règle → 403", async () => {
    await expect(admin.createRuleSet(SALARIE, RULE, AUDIT)).rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
    expect(rules.repoInsertRuleSet).not.toHaveBeenCalled();
  });
  it("un salarié ne peut PAS lister les contrats → 403", async () => {
    await expect(admin.listContracts(SALARIE)).rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
  });
  it("un salarié ne peut PAS créer d'horaire → 403", async () => {
    await expect(admin.createSchedule(SALARIE, { employee_id: CONTRACT.employee_id, day_of_week: 1, expected_start: null, expected_end: null, expected_break_minutes: 0, flexible_start_window: 0, flexible_end_window: 0, active: true }, AUDIT))
      .rejects.toMatchObject({ status: 403, code: "HR_FORBIDDEN" });
  });
});

describe("T5 — admin RH : un seul contrat actif par employé", () => {
  it("créer un 2e contrat actif → 409", async () => {
    rules.repoInsertContract.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(admin.createContract(RH, CONTRACT, AUDIT)).rejects.toMatchObject({ status: 409, code: "HR_CONTRACT_ACTIVE_EXISTS" });
  });
});
