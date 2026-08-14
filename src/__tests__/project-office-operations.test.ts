import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/project-office/services/project-office-access.service", () => ({
  requireProjectAccess: vi.fn(async () => ({ project_id: "p", owner_id: 7, visibility: "PRIVATE", effective_role: "OWNER" })),
  canManage: vi.fn(() => true),
}));
vi.mock("../module/project-office/repository/project-office.repository", () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ query: vi.fn() })),
  insertAuditLog: vi.fn(async () => undefined),
  insertProjectActivity: vi.fn(async () => undefined),
  isPgUniqueViolation: vi.fn((error: { code?: string }) => error?.code === "23505"),
}));
vi.mock("../module/project-office/repository/project-office-operations.repository", () => ({
  repoGetCurrentProjectBudget: vi.fn(),
  repoListProjectAffaireLinks: vi.fn(),
  repoGetProjectTimeBudget: vi.fn(),
  repoListOverdueMilestones: vi.fn(),
  repoListBlockingDependencies: vi.fn(),
  repoGetProjectBurnUp: vi.fn(),
  repoGetProjectRiskMatrix: vi.fn(),
  repoCreateProjectBudgetVersion: vi.fn(),
  repoAffaireExists: vi.fn(),
  repoCreateProjectAffaireLink: vi.fn(),
  repoDeleteProjectAffaireLink: vi.fn(),
}));
vi.mock("../module/margin-engine/services/margin-engine.service", () => ({ svcGetMargin: vi.fn() }));

import * as base from "../module/project-office/repository/project-office.repository";
import * as ops from "../module/project-office/repository/project-office-operations.repository";
import * as margin from "../module/margin-engine/services/margin-engine.service";
import * as service from "../module/project-office/services/project-office-operations.service";

const repository = vi.mocked(ops);
const marginService = vi.mocked(margin);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const AUDIT = { user_id: 7, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };

function budget(amount = "1000.000000") {
  return {
    id: "b", project_id: PROJECT, amount, currency: "EUR", effective_from: "2026-08-01", effective_to: null,
    definition: "Budget validé", source_type: "CONTRACT" as const, source_ref: "DEV-1",
    observed_at: "2026-08-01T10:00:00.000Z", reliability: "VERIFIED" as const,
    supersedes_id: null, created_by: 7, created_at: "2026-08-01T10:00:00.000Z",
  };
}

function marginResult(cost: string | null, partial: string) {
  return {
    actual: {
      cost_total_ht: cost, partial_cost_total_ht: partial, reliability: cost ? "ACTUAL" : "PARTIAL",
      freshness_at: "2026-08-14T08:00:00.000Z", missing_inputs: cost ? [] : [{ code: "MATERIAL_MISSING" }],
      calculation_hash: "hash",
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  repository.repoGetCurrentProjectBudget.mockResolvedValue(budget());
  repository.repoListProjectAffaireLinks.mockResolvedValue([
    { id: "l1", project_id: PROJECT, affaire_id: 10, affaire_reference: "AFF-10", affaire_status: "OUVERTE", source_ref: null, created_by: 7, created_at: "t" },
  ]);
  repository.repoGetProjectTimeBudget.mockResolvedValue({ work_package_count: 2, planned_hours: "12", consumed_hours: "5", planned_missing_count: 0, consumed_missing_count: 0, freshness_at: "2026-08-14T08:00:00.000Z" });
  repository.repoListOverdueMilestones.mockResolvedValue([]);
  repository.repoListBlockingDependencies.mockResolvedValue([]);
  repository.repoGetProjectBurnUp.mockResolvedValue([]);
  repository.repoGetProjectRiskMatrix.mockResolvedValue([]);
});

describe("SOL-24 project operations", () => {
  it("ne calcule pas un restant à partir d'un coût partiel", async () => {
    marginService.svcGetMargin.mockResolvedValue(marginResult(null, "123.45"));
    const result = await service.getProjectOperations({ id: 7, role: "Employee" }, PROJECT);
    expect(result.financial.consumed_ht).toBeNull();
    expect(result.financial.partial_consumed_ht).toBe("123.45");
    expect(result.financial.remaining_ht).toBeNull();
    expect(result.financial.reliability).toBe("PARTIAL");
    expect(result.data_quality).toContain("ACTUAL_COSTS_PARTIAL");
  });

  it("additionne précisément les coûts complets des affaires liées", async () => {
    repository.repoListProjectAffaireLinks.mockResolvedValue([
      { id: "l1", project_id: PROJECT, affaire_id: 10, affaire_reference: "A", affaire_status: "OUVERTE", source_ref: null, created_by: 7, created_at: "t" },
      { id: "l2", project_id: PROJECT, affaire_id: 11, affaire_reference: "B", affaire_status: "OUVERTE", source_ref: null, created_by: 7, created_at: "t" },
    ]);
    marginService.svcGetMargin
      .mockResolvedValueOnce(marginResult("100.10", "100.10"))
      .mockResolvedValueOnce(marginResult("200.20", "200.20"));
    const result = await service.getProjectOperations({ id: 7, role: "Employee" }, PROJECT);
    expect(result.financial.consumed_ht).toBe("300.30");
    expect(result.financial.remaining_ht).toBe("699.70");
    expect(result.financial.reliability).toBe("ACTUAL");
  });

  it("versionne le budget et audite la provenance", async () => {
    repository.repoCreateProjectBudgetVersion.mockResolvedValue({ ...budget("1200"), id: "b2", supersedes_id: "b" });
    const created = await service.createProjectBudget({ id: 7, role: "Direction" }, PROJECT, {
      amount: "1200", currency: "EUR", effective_from: "2026-08-15", definition: "Budget direction validé",
      source_type: "DECLARATION", source_ref: "DIR-2026-08", observed_at: "2026-08-14T08:00:00.000Z", reliability: "DECLARED",
    }, AUDIT);
    expect(created.supersedes_id).toBe("b");
    expect(vi.mocked(base.insertAuditLog)).toHaveBeenCalledWith(expect.anything(), AUDIT, expect.objectContaining({ action: "project-office.budget.version.create" }));
  });

  it("refuse une date de budget qui ne succède pas à la version courante", async () => {
    await expect(service.createProjectBudget({ id: 7, role: "Direction" }, PROJECT, {
      amount: "1200", currency: "EUR", effective_from: "2026-08-01", definition: "Budget direction validé",
      source_type: "DECLARATION", observed_at: "2026-08-14T08:00:00.000Z", reliability: "DECLARED",
    }, AUDIT)).rejects.toMatchObject({ status: 409, code: "PO_BUDGET_EFFECTIVE_DATE_INVALID" });
  });
});
