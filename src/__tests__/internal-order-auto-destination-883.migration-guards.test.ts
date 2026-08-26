import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const basename = "20260826_zzz_internal_order_auto_destination_883";
const readPatch = () => readFileSync(resolve(process.cwd(), "db/patches", `${basename}.sql`), "utf8");
const readSupport = (kind: "preflight" | "verify" | "rollback") =>
  readFileSync(resolve(process.cwd(), "db/patches/support", `${basename}.${kind}.sql`), "utf8");

describe("internal order automatic stock destination migration", () => {
  it("drops only the obsolete creation-time destination constraint", () => {
    const patch = readPatch();

    expect(patch).toMatch(/^BEGIN;/m);
    expect(patch).toContain("DROP CONSTRAINT IF EXISTS commande_client_internal_stock_dest_check");
    expect(patch).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(patch).toMatch(/COMMIT;\s*$/);
  });

  it("keeps preflight and verification read-only", () => {
    const preflight = readSupport("preflight");
    const verify = readSupport("verify");
    const mutatingSql = /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i;

    expect(preflight).toContain("BEGIN TRANSACTION READ ONLY");
    expect(verify).toContain("BEGIN TRANSACTION READ ONLY");
    expect(preflight).not.toMatch(mutatingSql);
    expect(verify).not.toMatch(mutatingSql);
    expect(verify).toContain("Obsolete internal stock destination constraint is still present");
  });

  it("refuses rollback once an internal order relies on automatic resolution", () => {
    const rollback = readSupport("rollback");

    expect(rollback).toContain("cerp.confirm_internal_order_destination_rollback");
    expect(rollback).toContain("Rollback refused: internal orders depend on automatic stock destination resolution");
    expect(rollback).toContain("ADD CONSTRAINT commande_client_internal_stock_dest_check");
  });
});
