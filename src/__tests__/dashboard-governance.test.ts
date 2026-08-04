import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  flags: vi.fn(),
  increment: vi.fn(),
  metrics: vi.fn(),
}));

vi.mock("../module/dashboard-governance/repository/dashboard-governance.repository", () => ({
  repoResolveDashboardFlags: repo.flags,
  repoIncrementDashboardUsage: repo.increment,
  repoListDashboardUsageMetrics: repo.metrics,
}));

import {
  resolveDashboardRoleBucket,
  svcGetDashboardGovernance,
  svcRecordDashboardUsage,
} from "../module/dashboard-governance/services/dashboard-governance.service";
import { dashboardUsageBodySchema } from "../module/dashboard-governance/validators/dashboard-governance.validators";

describe("dashboard governance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps effective roles to coarse non-identifying buckets", () => {
    expect(resolveDashboardRoleBucket("Employee | Opérateur")).toBe("operateur");
    expect(resolveDashboardRoleBucket("Qualité | Production")).toBe("qualite");
    expect(resolveDashboardRoleBucket("Approvisionnement")).toBe("achats");
    expect(resolveDashboardRoleBucket("Administrateur")).toBe("direction");
  });

  it("rolls the default back to V2 without disabling deep links", async () => {
    repo.flags.mockResolvedValue({ ariane_default_enabled: false, telemetry_enabled: true });
    const config = await svcGetDashboardGovernance(7);
    expect(config.default_experience).toBe("v2");
    expect(config.deep_links_preserved).toBe(true);
    expect(config.telemetry.identifiers_collected).toBe(false);
  });

  it("does not write when the telemetry kill-switch is off", async () => {
    repo.flags.mockResolvedValue({ ariane_default_enabled: true, telemetry_enabled: false });
    await expect(svcRecordDashboardUsage({
      user_id: 7,
      effective_role: "Production",
      input: { experience: "ariane", event_type: "view", selection_source: "default" },
    })).resolves.toEqual({ recorded: false });
    expect(repo.increment).not.toHaveBeenCalled();
  });

  it("rejects identifiers and free-form telemetry fields", () => {
    expect(() => dashboardUsageBodySchema.parse({
      experience: "ariane",
      event_type: "view",
      selection_source: "default",
      user_id: 42,
    })).toThrow();
  });

  it("keeps the migration additive and ships operational scripts", () => {
    const root = path.resolve(__dirname, "../..");
    const patch = fs.readFileSync(path.join(root, "db/patches/20260805_dashboard_convergence_governance.sql"), "utf8");
    expect(patch).toMatch(/CREATE TABLE IF NOT EXISTS public\.dashboard_usage_daily/);
    expect(patch).not.toMatch(/DROP\s+TABLE|TRUNCATE|DELETE\s+FROM/i);
    expect(patch).not.toMatch(/^\s*(user_id|ip_address|user_agent)\s+/im);
    for (const suffix of ["preflight", "verify", "rollback"]) {
      expect(fs.existsSync(path.join(root, `db/patches/support/20260805_dashboard_convergence_governance.${suffix}.sql`))).toBe(true);
    }
  });
});
