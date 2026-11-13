import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  commercial: vi.fn(),
  industrial: vi.fn(),
  finance: vi.fn(),
  references: vi.fn(),
}));
vi.mock("../repository/onboarding.repository", () => ({
  readCommercialSetupFacts: ports.commercial,
  readSetupFacts: ports.industrial,
}));
vi.mock(
  "../../facturation/repository/finance-configuration.repository",
  () => ({ repoGetFinanceConfigurationReadiness: ports.finance }),
);
vi.mock("../../reference-data/repository/reference-data.repository", () => ({
  repoReferenceCatalog: ports.references,
}));
import { getSetupStatus } from "./onboarding.service";
beforeEach(() => {
  vi.clearAllMocks();
  ports.commercial.mockResolvedValue({
    company_ready: true,
    primary_biller_id: "commercial-biller",
    current_step: "machines",
    login_count: 1,
  });
  ports.finance.mockResolvedValue({
    readiness: { ready: true },
    active_policy: { legal_entity_code: "commercial-biller" },
  });
});
describe("commercial enterprise setup", () => {
  it("requires the company's own identity and finance without an industrial setup", async () => {
    const result = await getSetupStatus(42, undefined, "COMMERCIAL");
    expect(result).toMatchObject({
      complete: true,
      applicable_steps: ["company", "finance", "review"],
      current_step: "company",
      machines: [],
      references: [],
    });
    expect(ports.industrial).not.toHaveBeenCalled();
    expect(ports.references).not.toHaveBeenCalled();
  });
  it("does not accept another enterprise's finance configuration as complete", async () => {
    ports.finance.mockResolvedValue({
      readiness: { ready: true },
      active_policy: { legal_entity_code: "another-biller" },
    });
    const result = await getSetupStatus(42, 2, "COMMERCIAL");
    expect(result.sections.finance).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.show_reminder).toBe(true);
    expect(result.login_count).toBe(2);
  });
});
