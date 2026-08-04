import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(resolve("db/patches/support", name), "utf8").replace(/\r\n?/g, "\n");

const preflight = read("20260804_commande_workflow_canonical_314.preflight.sql");
const verify = read("20260804_commande_workflow_canonical_314.verify.sql");

describe("#314 workflow SQL guards", () => {
  it.each([
    ["preflight", preflight],
    ["verify", verify],
  ])("keeps %s read-only and raises on a full-graph anomaly", (_label, sql) => {
    expect(sql).toContain("BEGIN TRANSACTION READ ONLY;");
    expect(sql).toContain("\\set ON_ERROR_STOP on");
    expect(sql).toContain("FULL OUTER JOIN public.commande_client_workflow_checkpoint");
    expect(sql).toContain("cp.status IS DISTINCT FROM e.checkpoint_status");
    expect(sql).toContain("cp.sort_order IS DISTINCT FROM e.sort_order");
    expect(sql).toMatch(/IF EXISTS \([\s\S]*SELECT 1 FROM anomaly[\s\S]*\) THEN\s+RAISE EXCEPTION/);
    expect(sql).toContain("ROLLBACK;");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+|FROM\s+)?public\./i);
  });

  it.each([preflight, verify])("pins every canonical checkpoint and both skip paths", (sql) => {
    for (const code of [
      "order_intake", "commercial_review", "technical_analysis", "stock_check",
      "of_generation", "planning_validation", "ar_preparation", "ar_sent",
      "production_launch", "production_completion", "quality_control", "delivery",
      "invoicing", "archive",
    ]) {
      expect(sql).toContain(`'${code}'`);
    }

    expect(sql).toContain("d.checkpoint_position IN (2,4,7,8,13)");
    expect(sql).toContain("'commande_fully_reserved_from_stock'");
    expect(sql).toContain("d.checkpoint_position IN (5,6,7,8,9,10,11)");
    expect(sql).toContain("d.checkpoint_position < p.active_position");
    expect(sql).toContain("ELSE 'pending'");
  });
});
