import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  flags: vi.fn(),
  increment: vi.fn(),
  metrics: vi.fn(),
}));

vi.mock("../module/planning/repository/planning-convergence.repository", () => ({
  repoResolvePlanningConvergenceFlags: repo.flags,
  repoIncrementPlanningUsage: repo.increment,
  repoListPlanningUsageMetrics: repo.metrics,
}));

import {
  resolvePlanningRoleBucket,
  svcGetPlanningConvergence,
  svcRecordPlanningUsage,
} from "../module/planning/services/planning-convergence.service";
import { planningUsageBodySchema } from "../module/planning/validators/planning-convergence.validators";

describe("planning convergence governance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps exact effective roles to coarse non-identifying buckets", () => {
    expect(resolvePlanningRoleBucket("Employee | Operateur atelier")).toBe("atelier");
    expect(resolvePlanningRoleBucket("Planification | Production")).toBe("planification");
    expect(resolvePlanningRoleBucket("Production")).toBe("production");
    expect(resolvePlanningRoleBucket("Secretaire")).toBe("secretariat");
    expect(resolvePlanningRoleBucket("Administrateur Systeme et Reseau")).toBe("direction");
    expect(resolvePlanningRoleBucket("Responsable Qualite")).toBe("other");
  });

  it("keeps legacy effective while the code decision is NO-GO, even if the flag is on", async () => {
    repo.flags.mockResolvedValue({ legacy_retirement_enabled: true, telemetry_enabled: true });

    const config = await svcGetPlanningConvergence(7);

    expect(config.retirement_decision).toBe("no_go");
    expect(config.legacy_dashboard_retirement_enabled).toBe(true);
    expect(config.legacy_dashboard_retired).toBe(false);
    expect(config.rollback_surface).toBe("legacy_dashboard");
    expect(config.telemetry.identifiers_collected).toBe(false);
  });

  it("does not write when the telemetry kill-switch is off", async () => {
    repo.flags.mockResolvedValue({ legacy_retirement_enabled: false, telemetry_enabled: false });
    await expect(svcRecordPlanningUsage({
      user_id: 7,
      effective_role: "Planification",
      input: { surface: "premium_route", event_type: "view", browser_family: "chromium" },
    })).resolves.toEqual({ recorded: false });
    expect(repo.increment).not.toHaveBeenCalled();
  });

  it("rejects identifiers, raw user agents, free text and incoherent transitions", () => {
    expect(() => planningUsageBodySchema.parse({
      surface: "premium_route",
      event_type: "view",
      browser_family: "chromium",
      user_id: 42,
    })).toThrow();
    expect(() => planningUsageBodySchema.parse({
      surface: "premium_route",
      event_type: "view",
      browser_family: "chromium",
      user_agent: "raw",
    })).toThrow();
    expect(() => planningUsageBodySchema.parse({
      surface: "premium_route",
      event_type: "open_premium",
      browser_family: "firefox",
    })).toThrow();
    expect(planningUsageBodySchema.parse({
      surface: "legacy_dashboard",
      event_type: "open_premium",
      browser_family: "webkit",
    })).toMatchObject({ surface: "legacy_dashboard", event_type: "open_premium" });
  });

  it("ships an inert canonical patch and independent retention maintenance", () => {
    const root = path.resolve(__dirname, "../..");
    const patch = fs.readFileSync(path.join(root, "db/patches/20260805_planning_convergence_governance.sql"), "utf8");
    const repository = fs.readFileSync(path.join(root, "src/module/planning/repository/planning-convergence.repository.ts"), "utf8");
    const maintenance = fs.readFileSync(path.join(root, "scripts/prune-planning-usage.js"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };

    expect(patch).toMatch(/CREATE TABLE public\.planning_surface_usage_daily/);
    expect(patch).toContain("CREATE FUNCTION public.prune_planning_surface_usage_daily");
    expect(patch).toMatch(/'PLANNING_LEGACY_DASHBOARD_RETIREMENT'[\s\S]*false[\s\S]*'PLANNING_USAGE_METRICS'[\s\S]*false/);
    expect(patch).not.toMatch(/^\s*(user_id|ip_address|user_agent|session_id)\s+/im);
    expect(repository).toContain("ff.enabled IS TRUE AND COALESCE(ffu.enabled, TRUE) IS TRUE");
    expect(repository).not.toMatch(/DELETE FROM public\.planning_surface_usage_daily/);
    expect(maintenance).toContain("public.prune_planning_surface_usage_daily");
    expect(packageJson.scripts["maintenance:planning-usage"]).toBe("node scripts/prune-planning-usage.js");

    for (const suffix of ["preflight", "verify", "rollback"]) {
      expect(fs.existsSync(path.join(root, `db/patches/support/20260805_planning_convergence_governance.${suffix}.sql`))).toBe(true);
    }
  });

  it("guards baseline verification and destructive rollback with exact provenance", () => {
    const root = path.resolve(__dirname, "../..");
    const patch = fs.readFileSync(path.join(root, "db/patches/20260805_planning_convergence_governance.sql"), "utf8");
    const verify = fs.readFileSync(path.join(root, "db/patches/support/20260805_planning_convergence_governance.verify.sql"), "utf8");
    const rollback = fs.readFileSync(path.join(root, "db/patches/support/20260805_planning_convergence_governance.rollback.sql"), "utf8");
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

  it("uses the same exact-role planning policy for the programmation route", () => {
    const root = path.resolve(__dirname, "../..");
    const route = fs.readFileSync(path.join(root, "src/module/programmation/routes/programmation.routes.ts"), "utf8");

    expect(route).toContain("roleHasPlanningAccess");
    expect(route).not.toContain(".includes(");
    expect(route).not.toContain("isAdminRole");
    expect(route).not.toContain("isProductionRole");
  });
});
