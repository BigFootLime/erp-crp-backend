import { createHash } from "node:crypto";
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

  it("accepts only coherent bounded telemetry transitions", () => {
    expect(dashboardUsageBodySchema.parse({
      experience: "v2",
      event_type: "switch",
      selection_source: "switch",
      previous_experience: "legacy",
    })).toMatchObject({ experience: "v2", previous_experience: "legacy" });

    for (const invalid of [
      { experience: "v2", event_type: "switch", selection_source: "switch" },
      { experience: "v2", event_type: "switch", selection_source: "switch", previous_experience: "v2" },
      { experience: "legacy", event_type: "deep_link", selection_source: "default" },
      { experience: "v2", event_type: "fallback", selection_source: "query" },
      { experience: "v2", event_type: "view", selection_source: "default", previous_experience: "legacy" },
    ]) {
      expect(() => dashboardUsageBodySchema.parse(invalid)).toThrow();
    }
  });

  it("ships a fail-closed canonical patch and independent retention maintenance", () => {
    const root = path.resolve(__dirname, "../..");
    const patch = fs.readFileSync(path.join(root, "db/patches/20260805_dashboard_convergence_governance.sql"), "utf8");
    const repository = fs.readFileSync(path.join(root, "src/module/dashboard-governance/repository/dashboard-governance.repository.ts"), "utf8");
    const maintenance = fs.readFileSync(path.join(root, "scripts/prune-dashboard-usage.js"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

    expect(patch).toMatch(/CREATE TABLE public\.dashboard_usage_daily/);
    expect(patch).toContain("CREATE FUNCTION public.prune_dashboard_usage_daily");
    expect(patch).toMatch(/'DASHBOARD_ARIANE_DEFAULT'[\s\S]*false[\s\S]*'DASHBOARD_USAGE_METRICS'[\s\S]*false/);
    expect(fs.existsSync(path.join(root, "db/seeds/dashboard-convergence-flags.sql"))).toBe(false);
    expect(patch).not.toMatch(/^\s*(user_id|ip_address|user_agent)\s+/im);
    expect(repository).toContain("ff.enabled IS TRUE AND COALESCE(ffu.enabled, TRUE) IS TRUE");
    expect(repository).not.toMatch(/DELETE FROM public\.dashboard_usage_daily/);
    expect(maintenance).toContain("public.prune_dashboard_usage_daily");
    expect(packageJson.scripts["maintenance:dashboard-usage"]).toBe("node scripts/prune-dashboard-usage.js");

    for (const suffix of ["preflight", "verify", "rollback"]) {
      expect(fs.existsSync(path.join(root, `db/patches/support/20260805_dashboard_convergence_governance.${suffix}.sql`))).toBe(true);
    }
  });

  it("guards read-only verification and destructive rollback with exact provenance", () => {
    const root = path.resolve(__dirname, "../..");
    const patch = fs.readFileSync(path.join(root, "db/patches/20260805_dashboard_convergence_governance.sql"), "utf8");
    const verify = fs.readFileSync(path.join(root, "db/patches/support/20260805_dashboard_convergence_governance.verify.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260805_dashboard_convergence_governance.rollback.sql"), "utf8");
    const expectedSha = createHash("sha256").update(patch.replace(/\r\n?/g, "\n"), "utf8").digest("hex");

    expect(verify).toContain("BEGIN TRANSACTION READ ONLY");
    expect(verify).toContain(expectedSha);
    expect(verify).toContain("both baseline flags must exist globally and remain OFF");
    expect(rollback).toContain("current_database() NOT IN ('cerp_dev', 'cerp_test')");
    expect(rollback).toContain("SELECT pg_advisory_xact_lock(hashtext('cerp_schema_migrations'))");
    expect(rollback).toContain(expectedSha);
    expect(rollback).toContain("usage evidence exists; export/retention decision required");
    expect(rollback).toContain("DELETE FROM public.cerp_schema_migrations");
  });
});
